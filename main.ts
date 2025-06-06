// fichier : main.ts (ou stack.ts, selon votre architecture)
import { Construct } from "constructs";
import {
  App,
  TerraformStack,
  TerraformVariable,
  TerraformOutput,
  S3Backend,
  Fn,
} from "cdktf";
import {
  DataAwsAmiFilter,
  DataAwsAmi,
} from "@cdktf/provider-aws/lib/data-aws-ami";
import {
  InstanceMetadataOptions,
  Instance,
} from "@cdktf/provider-aws/lib/instance";
import {
  AwsProviderDefaultTags,
  AwsProvider,
} from "@cdktf/provider-aws/lib/provider";
import {
  SecurityGroupIngress,
  SecurityGroup,
} from "@cdktf/provider-aws/lib/security-group";
import { Vpc } from "./.gen/modules/vpc";
import { S3Bucket } from "@cdktf/provider-aws/lib/s3-bucket";
import { S3BucketPublicAccessBlock } from "@cdktf/provider-aws/lib/s3-bucket-public-access-block";
import {
  s3BucketVersioning,
  s3BucketServerSideEncryptionConfiguration,
} from "@cdktf/provider-aws";
import * as path from "path";

export interface BaseStackProps {
  readonly envName: string;
  readonly backendBucket: string;
  readonly createBackendBucket: boolean;
}

export class BaseStack extends TerraformStack {
  constructor(scope: Construct, id: string, props: BaseStackProps) {
    super(scope, id);

    // exiger au minimum Terraform >= 1.12.1
    this.addOverride("terraform.required_version", ">= 1.12.1");

    // configuration du backend S3 (ça pointe vers le bucket même s'il existe déjà)
    new S3Backend(this, {
      bucket: props.backendBucket,
      key: `${props.envName}/terraform.tfstate`,
      region: "eu-west-3",
      encrypt: true,
    }).addOverride("use_lockfile", true); // solution de contournement pour activer le verrouillage

    // variables
    const awsRegion = new TerraformVariable(this, "aws_region", {
      type: "string",
      default: "eu-west-3",
      description: "la région `aws` où les ressources seront déployées",
    });
    const projectName = new TerraformVariable(this, "project_name", {
      type: "string",
      default: "Projet1-IaC",
      description: "nom du projet : utilisé pour le taggage des ressources",
    });
    const vpcCidrBlock = new TerraformVariable(this, "vpc_cidr_block", {
      type: "string",
      default: "10.0.0.0/16",
      description: "le bloc cidr pour le `vpc` principal",
    });

    // provider AWS avec tags par défaut
    new AwsProvider(this, "Aws", {
      region: awsRegion.value,
      defaultTags: [
        <AwsProviderDefaultTags>{
          tags: {
            ManagedBy: "Terraform",
            Project: projectName.value,
            Environment: props.envName,
          },
        },
      ],
    });

    // récupération de l’AMI Amazon Linux 2023
    const image = new DataAwsAmi(this, "amazonLinux2023", {
      mostRecent: true,
      owners: ["amazon"],
      filter: [
        <DataAwsAmiFilter>{
          name: "name",
          values: ["al2023-ami-*-kernel-*-x86_64"],
        },
        <DataAwsAmiFilter>{ name: "virtualization-type", values: ["hvm"] },
        <DataAwsAmiFilter>{ name: "architecture", values: ["x86_64"] },
      ],
    });

    // module VPC via terraform-aws-modules/vpc/aws
    const vpcModule = new Vpc(this, "vpc", {
      name: `${projectName.value}-vpc-${props.envName}`,
      cidr: vpcCidrBlock.value,
      azs: [
        `${awsRegion.value}a`,
        `${awsRegion.value}b`,
        `${awsRegion.value}c`,
      ],
      privateSubnets: ["10.0.1.0/24", "10.0.2.0/24", "10.0.3.0/24"],
      publicSubnets: ["10.0.101.0/24", "10.0.102.0/24", "10.0.103.0/24"],
      enableNatGateway: props.envName === "prod",
      singleNatGateway: true,
      enableDnsHostnames: true,
      enableDnsSupport: true,
      tags: {
        ManagedBy: "Terraform",
        Project: projectName.value,
        Environment: props.envName,
      },
    });

    const myVpcId = vpcModule.vpcIdOutput;
    const premierPublicSubnetId = Fn.element(vpcModule.publicSubnetsOutput, 0);

    // security group pour autoriser le trafic HTTP entrant
    const httpIngress: SecurityGroupIngress = {
      description: "http depuis n importe ou",
      fromPort: 80,
      toPort: 80,
      protocol: "tcp",
      cidrBlocks: ["0.0.0.0/0"],
      ipv6CidrBlocks: ["::/0"],
    };

    const webSg = new SecurityGroup(this, "webSg", {
      name: `web-sg-${projectName.value}-${props.envName}`,
      description: `autorise http entrant pour ${projectName.value} ${props.envName}`,
      vpcId: myVpcId,
      ingress: [httpIngress],
      egress: [
        {
          description: "autorise tout le trafic sortant",
          fromPort: 0,
          toPort: 0,
          protocol: "-1",
          cidrBlocks: ["0.0.0.0/0"],
          ipv6CidrBlocks: ["::/0"],
        },
      ],
      tags: {
        Name: `WebServer-SG-${projectName.value}`,
        Project: projectName.value,
        ManagedBy: "Terraform",
        Environment: props.envName,
      },
    });

    // instance EC2 pour le serveur web
    new Instance(this, "webServer", {
      ami: image.id,
      instanceType: props.envName === "prod" ? "t3.small" : "t2.micro",
      subnetId: premierPublicSubnetId,
      associatePublicIpAddress: true,
      vpcSecurityGroupIds: [webSg.id],
      metadataOptions: <InstanceMetadataOptions>{
        httpTokens: "required",
        httpEndpoint: "enabled",
      },
      userData: Fn.templatefile(path.join(__dirname, "user_data_script.tpl"), {
        environment_name_tpl: props.envName,
        project_name_tpl: projectName.value,
      }),
      tags: {
        Name: `WebServer-NGINX-${projectName.value}-${props.envName}`,
        Environment: props.envName,
        ManagedBy: "Terraform",
        Project: projectName.value,
      },
    });

    new TerraformOutput(this, "web_server_public_ip", {
      description: "IP publique du serveur web",
      value: Fn.element(["${aws_instance.webServer.public_ip}"], 0),
    });

    // si createBackendBucket=true -> on crée le bucket ; sinon on suppose qu'il existe déjà
    if (props.createBackendBucket) {
      const tfstateBucket = new S3Bucket(this, "tfstate", {
        bucket: props.backendBucket,
        tags: {
          Name: `Terraform State Bucket - ${props.envName}`,
          Environment: "Backend",
          ManagedBy: "Terraform",
        },
      });

      // versioning
      new s3BucketVersioning.S3BucketVersioningA(this, "tfstateVersioning", {
        bucket: tfstateBucket.bucket,
        versioningConfiguration: {
          status: "Enabled",
        },
      });

      // chiffrement SSE
      new s3BucketServerSideEncryptionConfiguration.S3BucketServerSideEncryptionConfigurationA(
        this,
        "tfstateEncryption",
        {
          bucket: tfstateBucket.bucket,
          rule: [
            {
              applyServerSideEncryptionByDefault: {
                sseAlgorithm: "AES256",
              },
            },
          ],
        }
      );

      // blocage de l’accès public
      new S3BucketPublicAccessBlock(this, "tfstatePublicAccessBlock", {
        bucket: tfstateBucket.bucket,
        blockPublicAcls: true,
        blockPublicPolicy: true,
        ignorePublicAcls: true,
        restrictPublicBuckets: true,
      });
    }

    // outputs utiles
    new TerraformOutput(this, "vpc_id", {
      description: "id du vpc créé par le module",
      value: myVpcId,
    });
  }
}

const app = new App();

// récupérer le workspace Terraform (dev ou prod)
const workspace = process.env.TF_WORKSPACE || "default";

// on instancie la stack en réglant createBackendBucket à true uniquement la première fois
new BaseStack(app, "stack", {
  envName: workspace,
  backendBucket: `mon-tfstate-bucket-projet1-unique-12345`,
  createBackendBucket: false, // mettre à true pour la première exécution
  // sinon, on suppose que le bucket existe déjà
});

app.synth();
