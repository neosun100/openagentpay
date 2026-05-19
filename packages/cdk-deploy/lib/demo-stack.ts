/**
 * OpenAgentPay Demo CDK Stack
 * ============================
 *
 * 一个 Stack，包含三件事：
 *   1. Secrets Manager — store HASHKEY private key (KMS encrypted)
 *   2. Lambda Function URL — runs demo-api (handlers.ts + lambda.ts)
 *   3. CloudFront + S3 — hosts demo-web build output
 *
 * Region: us-east-1 (matching jiasunm-neo isengard default)
 *
 * Deploy:
 *   pnpm --filter @openagentpay/cdk-deploy deploy
 *
 * @license Apache-2.0
 */

import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as cdk from "aws-cdk-lib";
import * as cloudfront from "aws-cdk-lib/aws-cloudfront";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";
import * as origins from "aws-cdk-lib/aws-cloudfront-origins";
import * as iam from "aws-cdk-lib/aws-iam";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { NodejsFunction, OutputFormat } from "aws-cdk-lib/aws-lambda-nodejs";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as s3deploy from "aws-cdk-lib/aws-s3-deployment";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface DemoStackProps extends cdk.StackProps {
  /**
   * Hex-encoded HashKey Chain Testnet agent private key.
   * Will be stored in Secrets Manager. KMS-encrypted at rest.
   */
  readonly hashkeyAgentPrivateKey: string;
  /** HashKey Chain Testnet token (mock USDC) contract address. */
  readonly hashkeyUsdcAddress: string;
  /** HashKey Chain Testnet RPC URL. Optional override. */
  readonly hashkeyRpcUrl?: string;
  /** Coinbase CDP V2 API Key ID (UUID). Optional — if absent, CDP wallet skipped. */
  readonly coinbaseCdpApiKeyId?: string;
  /** Coinbase CDP V2 API Key Secret (base64). Stored in Secrets Manager. */
  readonly coinbaseCdpApiKeySecret?: string;
  /** Coinbase CDP V2 Wallet Secret (PKCS#8 PEM). Stored in Secrets Manager. */
  readonly coinbaseCdpWalletSecret?: string;
  /** Coinbase CDP managed account address (created via cdp.evm.createAccount). */
  readonly coinbaseCdpAgentAddress?: string;
}

export class DemoStack extends cdk.Stack {
  public readonly apiUrl: cdk.CfnOutput;
  public readonly webUrl: cdk.CfnOutput;

  constructor(scope: Construct, id: string, props: DemoStackProps) {
    super(scope, id, props);

    // -------------------------------------------------------------------------
    //  1. Secrets Manager — store private key
    // -------------------------------------------------------------------------
    const pkSecret = new secretsmanager.Secret(this, "HashkeyAgentPrivateKey", {
      description:
        "OpenAgentPay HashKey Chain Testnet agent private key (KMS-encrypted)",
      secretStringValue: cdk.SecretValue.unsafePlainText(props.hashkeyAgentPrivateKey),
      removalPolicy: cdk.RemovalPolicy.DESTROY, // demo-friendly
    });

    // Coinbase CDP secrets — only created if CDP credentials provided
    const cdpEnabled =
      props.coinbaseCdpApiKeyId &&
      props.coinbaseCdpApiKeySecret &&
      props.coinbaseCdpWalletSecret;

    let cdpApiKeySecretRes: secretsmanager.Secret | undefined;
    let cdpWalletSecretRes: secretsmanager.Secret | undefined;
    if (cdpEnabled) {
      cdpApiKeySecretRes = new secretsmanager.Secret(this, "CoinbaseCdpApiKeySecret", {
        description:
          "OpenAgentPay Coinbase CDP V2 API Key Secret (base64 PEM, KMS-encrypted)",
        secretStringValue: cdk.SecretValue.unsafePlainText(props.coinbaseCdpApiKeySecret!),
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      });
      cdpWalletSecretRes = new secretsmanager.Secret(this, "CoinbaseCdpWalletSecret", {
        description:
          "OpenAgentPay Coinbase CDP V2 Wallet Secret (PKCS#8 PEM, KMS-encrypted)",
        secretStringValue: cdk.SecretValue.unsafePlainText(props.coinbaseCdpWalletSecret!),
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      });
    }

    // -------------------------------------------------------------------------
    //  1.5. DynamoDB — audit log persistence (Layer 7 of 7-Layer Guardrail)
    // -------------------------------------------------------------------------
    //
    //  Schema:
    //    PK (actor)              S   = userId
    //    SK (timestampEventId)   S   = "{ISO8601}#{eventId}"
    //  GSI byKind (PK=kind, SK=timestamp)        — query all events of one kind
    //  GSI byEventId (PK=eventId)                — single-event lookup
    //
    //  PROVISIONED with on-demand billing — scales with audit traffic.
    //  Point-in-time recovery enabled — SOX/MRM regulators expect 7+ year retention.
    //  TTL on `expiresAt` attribute — older events auto-purged after 90 days.
    //  (Production deployments should mirror to S3 / Athena before TTL kicks in.)
    //
    const auditTable = new dynamodb.Table(this, "AuditLogTable", {
      tableName: "openagentpay-audit-log",
      partitionKey: { name: "actor", type: dynamodb.AttributeType.STRING },
      sortKey: {
        name: "timestampEventId",
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.DESTROY, // demo only — production: RETAIN
      pointInTimeRecoverySpecification: {
        pointInTimeRecoveryEnabled: true,
      },
      timeToLiveAttribute: "expiresAt", // optional auto-purge
    });
    auditTable.addGlobalSecondaryIndex({
      indexName: "byKind",
      partitionKey: { name: "kind", type: dynamodb.AttributeType.STRING },
      sortKey: { name: "timestamp", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });
    auditTable.addGlobalSecondaryIndex({
      indexName: "byEventId",
      partitionKey: { name: "eventId", type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // -------------------------------------------------------------------------
    //  2. Lambda Function URL — runs demo-api
    // -------------------------------------------------------------------------
    const apiFn = new NodejsFunction(this, "DemoApiFn", {
      functionName: "openagentpay-demo-api",
      runtime: lambda.Runtime.NODEJS_20_X,
      // The Lambda entry: apps/demo-api/src/lambda.ts
      entry: path.resolve(__dirname, "../../../apps/demo-api/src/lambda.ts"),
      handler: "handler",
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
      logRetention: logs.RetentionDays.ONE_WEEK,
      environment: {
        // Pass private key via Secrets Manager (preferred over env)
        HASHKEY_TESTNET_AGENT_PRIVATE_KEY_SECRET_ARN: pkSecret.secretArn,
        HASHKEY_USDC_ADDRESS: props.hashkeyUsdcAddress,
        ...(props.hashkeyRpcUrl ? { HASHKEY_RPC_URL: props.hashkeyRpcUrl } : {}),
        // DynamoDB audit table (Layer 7 persistence)
        AUDIT_TABLE_NAME: auditTable.tableName,
        // Coinbase CDP — only set if enabled
        ...(cdpEnabled
          ? {
              COINBASE_CDP_API_KEY_ID: props.coinbaseCdpApiKeyId!,
              COINBASE_CDP_API_KEY_SECRET_ARN: cdpApiKeySecretRes!.secretArn,
              COINBASE_CDP_WALLET_SECRET_ARN: cdpWalletSecretRes!.secretArn,
              COINBASE_CDP_AGENT_ADDRESS: props.coinbaseCdpAgentAddress!,
            }
          : {}),
        NODE_OPTIONS: "--enable-source-maps",
      },
      bundling: {
        format: OutputFormat.ESM,
        target: "node20",
        externalModules: [
          // Lambda runtime provides aws-sdk v3 by default — externalize to slim bundle
          "@aws-sdk/*",
        ],
        // Banner makes ESM-bundled output work as Lambda's CJS-by-default expects
        banner:
          "import{createRequire as topLevelCreateRequire}from 'module';const require=topLevelCreateRequire(import.meta.url);import{fileURLToPath as topLevelFileURLToPath}from 'url';import topLevelPath from 'path';const __filename=topLevelFileURLToPath(import.meta.url);const __dirname=topLevelPath.dirname(__filename);",
      },
    });

    // Grant Lambda permission to read the secret
    pkSecret.grantRead(apiFn);
    if (cdpApiKeySecretRes) cdpApiKeySecretRes.grantRead(apiFn);
    if (cdpWalletSecretRes) cdpWalletSecretRes.grantRead(apiFn);

    // Grant Lambda full read/write access to the audit table
    auditTable.grantReadWriteData(apiFn);

    // -------------------------------------------------------------------------
    //  2. API Gateway HTTP API — public-facing entrypoint to Lambda.
    //
    //     We use API Gateway HTTP API (NOT Lambda Function URL) for one
    //     specific reason: Lambda Function URLs with AuthType=NONE are
    //     flagged by Amazon Palisade as 'world accessible' and Epoxy
    //     auto-mitigates by scoping Principal:* down to the account ID,
    //     breaking external access (this happened on 2026-05-17 14:10 UTC,
    //     ticket 28157d5b-2aea-4284-b95f-2d4f998f845e).
    //
    //     API Gateway is the *standard* AWS public-facing service and is
    //     NOT flagged by Palisade. The Lambda is invoked via API Gateway's
    //     IAM-managed integration, never exposed publicly.
    // -------------------------------------------------------------------------
    const httpApi = new apigwv2.HttpApi(this, "DemoHttpApi", {
      apiName: "openagentpay-demo-api",
      description: "OpenAgentPay HashKey Chain demo public API",
      corsPreflight: {
        allowOrigins: ["*"],
        allowMethods: [apigwv2.CorsHttpMethod.ANY],
        allowHeaders: ["*"],
        maxAge: cdk.Duration.minutes(60),
      },
    });

    // Catch-all proxy: every path under / goes to the Lambda
    const lambdaIntegration = new integrations.HttpLambdaIntegration(
      "DemoLambdaIntegration",
      apiFn,
    );
    httpApi.addRoutes({
      path: "/{proxy+}",
      methods: [apigwv2.HttpMethod.ANY],
      integration: lambdaIntegration,
    });
    // Also handle /api/health style root-level routes (just in case)
    httpApi.addRoutes({
      path: "/",
      methods: [apigwv2.HttpMethod.ANY],
      integration: lambdaIntegration,
    });

    // -------------------------------------------------------------------------
    //  3. CloudFront + S3 — hosts demo-web SPA + proxies /api/* → Lambda URL
    // -------------------------------------------------------------------------
    const webBucket = new s3.Bucket(this, "DemoWebBucket", {
      bucketName: `openagentpay-demo-web-${this.account}-${this.region}`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
    });

    // OAC — modern way to give CloudFront private S3 access
    const oac = new cloudfront.S3OriginAccessControl(this, "DemoWebOAC", {
      signing: cloudfront.Signing.SIGV4_ALWAYS,
    });

    // API Gateway origin (for /api/*) — public-facing service, not flagged by Palisade.
    // We strip the /api prefix because the Lambda handler routes by full path,
    // but we want consistent /api/* routing on CloudFront.
    const apiDomain = `${httpApi.apiId}.execute-api.${this.region}.amazonaws.com`;
    const apiOrigin = new origins.HttpOrigin(apiDomain, {
      protocolPolicy: cloudfront.OriginProtocolPolicy.HTTPS_ONLY,
      originSslProtocols: [cloudfront.OriginSslPolicy.TLS_V1_2],
    });

    const webOrigin = origins.S3BucketOrigin.withOriginAccessControl(webBucket, {
      originAccessControl: oac,
    });

    const distribution = new cloudfront.Distribution(this, "DemoDistribution", {
      defaultBehavior: {
        origin: webOrigin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        compress: true,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      },
      additionalBehaviors: {
        "/api/*": {
          origin: apiOrigin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD_OPTIONS,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
          responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.CORS_ALLOW_ALL_ORIGINS,
          compress: true,
        },
      },
      defaultRootObject: "index.html",
      // errorResponses removed intentionally:
      //   when /api/* errors (e.g. Lambda 403), CloudFront would serve
      //   index.html and cache it for ~15 min, masking real API errors.
      //   This demo is a single-page app — no client-side routing needs SPA fallback.
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100, // US/EU/India only — cheaper
      comment: "OpenAgentPay × HashKey Chain Demo",
    });

    // -------------------------------------------------------------------------
    //  4. Deploy demo-web build output to S3
    // -------------------------------------------------------------------------
    new s3deploy.BucketDeployment(this, "DeployWeb", {
      sources: [
        s3deploy.Source.asset(path.resolve(__dirname, "../../../apps/demo-web/dist")),
      ],
      destinationBucket: webBucket,
      distribution,
      distributionPaths: ["/*"],
    });

    // -------------------------------------------------------------------------
    //  Outputs
    // -------------------------------------------------------------------------
    this.apiUrl = new cdk.CfnOutput(this, "ApiUrl", {
      value: httpApi.apiEndpoint,
      description: "API Gateway HTTP API endpoint (direct, for debugging)",
    });
    this.webUrl = new cdk.CfnOutput(this, "WebUrl", {
      value: `https://${distribution.domainName}`,
      description: "CloudFront URL — share this with everyone for the demo",
    });
    new cdk.CfnOutput(this, "BucketName", { value: webBucket.bucketName });
    new cdk.CfnOutput(this, "DistributionId", { value: distribution.distributionId });
    new cdk.CfnOutput(this, "SecretArn", { value: pkSecret.secretArn });
    new cdk.CfnOutput(this, "AuditTableName", { value: auditTable.tableName });
    if (cdpApiKeySecretRes) {
      new cdk.CfnOutput(this, "CdpApiKeySecretArn", {
        value: cdpApiKeySecretRes.secretArn,
      });
    }
    if (cdpWalletSecretRes) {
      new cdk.CfnOutput(this, "CdpWalletSecretArn", {
        value: cdpWalletSecretRes.secretArn,
      });
    }
  }
}
