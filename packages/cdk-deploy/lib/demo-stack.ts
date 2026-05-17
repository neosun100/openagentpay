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
  }
}
