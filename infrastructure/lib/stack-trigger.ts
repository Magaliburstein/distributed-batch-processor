import * as cdk from 'aws-cdk-lib';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';

interface StackTriggerProps extends cdk.StackProps {
  environment: string;
  orchestratorFunction: lambda.Function;
}

export class StackTrigger extends cdk.Stack {
  constructor(scope: Construct, id: string, props: StackTriggerProps) {
    super(scope, id, props);

    const { environment, orchestratorFunction } = props;

    const triggerRole = new iam.Role(this, 'NightlyTriggerRole', {
      roleName: `tapi-nightly-trigger-role-${environment}`,
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com'),
    });

    triggerRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['lambda:InvokeFunction'],
        resources: [orchestratorFunction.functionArn],
      }),
    );

    // EventBridge Scheduler — dispara el orquestador diariamente a medianoche UTC
    new scheduler.CfnSchedule(this, 'NightlyOrchestratorSchedule', {
      name: `tapi-nightly-${environment}`,
      description: `Dispara el orquestador batch Tapi diariamente a medianoche UTC (${environment})`,
      scheduleExpression: 'cron(0 0 * * ? *)',
      scheduleExpressionTimezone: 'UTC',
      flexibleTimeWindow: { mode: 'OFF' },
      state: 'ENABLED',
      target: {
        arn: orchestratorFunction.functionArn,
        roleArn: triggerRole.roleArn,
        input: JSON.stringify({ source: 'tapi-nightly-scheduler' }),
        retryPolicy: {
          maximumRetryAttempts: 3,
          maximumEventAgeInSeconds: 3600,
        },
      },
    });
  }
}
