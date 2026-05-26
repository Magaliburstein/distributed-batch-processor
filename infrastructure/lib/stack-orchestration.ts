import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaNode from 'aws-cdk-lib/aws-lambda-nodejs';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import * as path from 'path';

interface StackOrchestrationProps extends cdk.StackProps {
  environment: string;
  configTable: dynamodb.Table;
  paginatorFunction: lambda.Function;
  sqsQueueUrlPrefix: string;
  databaseUrl: string;
}

export class StackOrchestration extends cdk.Stack {
  readonly orchestratorFunction: lambda.Function;
  readonly schedulerRole: iam.Role;

  constructor(scope: Construct, id: string, props: StackOrchestrationProps) {
    super(scope, id, props);

    const { environment, paginatorFunction, sqsQueueUrlPrefix, databaseUrl } = props;

    // Rol que EventBridge Scheduler usará para invocar la Lambda paginadora
    this.schedulerRole = new iam.Role(this, 'SchedulerExecutionRole', {
      roleName: `tapi-scheduler-role-${environment}`,
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com'),
    });

    this.schedulerRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['lambda:InvokeFunction'],
        resources: [paginatorFunction.functionArn],
      }),
    );

    this.orchestratorFunction = new lambdaNode.NodejsFunction(this, 'OrchestratorFunction', {
      functionName: `tapi-orchestrator-${environment}`,
      entry: path.join(__dirname, '../../src/lambdas/orchestrator/index.ts'),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_20_X,
      timeout: cdk.Duration.minutes(5),
      memorySize: 256,
      environment: {
        SOURCE_TABLE: `registros_${environment}`,
        PAGINATOR_LAMBDA_ARN: paginatorFunction.functionArn,
        SCHEDULER_ROLE_ARN: this.schedulerRole.roleArn,
        SQS_QUEUE_URL_PREFIX: sqsQueueUrlPrefix,
        SCHEDULER_GROUP_NAME: `tapi-batch-${environment}`,
        ENVIRONMENT: environment,
        DATABASE_URL: databaseUrl,
      },
      bundling: { minify: true, sourceMap: true },
    });

    // Permisos para crear y gestionar schedules dinámicos por proveedor
    this.orchestratorFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          'scheduler:CreateSchedule',
          'scheduler:DeleteSchedule',
          'scheduler:GetSchedule',
          'scheduler:ListSchedules',
        ],
        resources: [`arn:aws:scheduler:${this.region}:${this.account}:schedule/tapi-batch-${environment}/*`],
      }),
    );

    // PassRole necesario para que el orquestador delegue el rol al Scheduler
    this.orchestratorFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['iam:PassRole'],
        resources: [this.schedulerRole.roleArn],
      }),
    );

    // Grupo de schedules para agrupar los schedules dinámicos
    new cdk.CfnResource(this, 'SchedulerGroup', {
      type: 'AWS::Scheduler::ScheduleGroup',
      properties: {
        Name: `tapi-batch-${environment}`,
      },
    });

    new cdk.CfnOutput(this, 'OrchestratorFunctionArn', {
      value: this.orchestratorFunction.functionArn,
    });
  }
}
