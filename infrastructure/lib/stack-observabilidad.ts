import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as snsSubscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';

interface StackObservabilidadProps extends cdk.StackProps {
  environment: string;
  providers: string[];
  workerFunctions: Map<string, lambda.Function>;
  dlqQueues: Map<string, sqs.Queue>;
  orchestratorFunction: lambda.Function;
  alertEmail: string;
}

export class StackObservabilidad extends cdk.Stack {
  constructor(scope: Construct, id: string, props: StackObservabilidadProps) {
    super(scope, id, props);

    const { environment, providers, workerFunctions, dlqQueues, orchestratorFunction, alertEmail } =
      props;

    const alertTopic = new sns.Topic(this, 'AlertTopic', {
      topicName: `tapi-alertas-${environment}`,
      displayName: `Tapi Batch Alertas — ${environment}`,
    });

    alertTopic.addSubscription(new snsSubscriptions.EmailSubscription(alertEmail));

    const alarms: cloudwatch.Alarm[] = [];

    // Alarma: orquestador no fue invocado en las últimas 26h (permite tolerancia)
    const orchestratorInvocationsAlarm = new cloudwatch.Alarm(
      this,
      'OrchestratorNoInvocado',
      {
        alarmName: `tapi-orchestrator-no-invocado-${environment}`,
        alarmDescription: 'El orquestador no fue invocado en las últimas 26 horas',
        metric: orchestratorFunction.metricInvocations({
          period: cdk.Duration.hours(26),
          statistic: 'Sum',
        }),
        threshold: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.BREACHING,
      },
    );
    alarms.push(orchestratorInvocationsAlarm);

    // Alarma: tasa de errores del orquestador
    const orchestratorErrorsAlarm = new cloudwatch.Alarm(this, 'OrchestratorErrors', {
      alarmName: `tapi-orchestrator-errors-${environment}`,
      alarmDescription: 'El orquestador tuvo errores en la última ejecución',
      metric: orchestratorFunction.metricErrors({ period: cdk.Duration.hours(1), statistic: 'Sum' }),
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    alarms.push(orchestratorErrorsAlarm);

    for (const proveedor of providers) {
      const dlq = dlqQueues.get(proveedor);
      const workerFn = workerFunctions.get(proveedor);
      if (!dlq || !workerFn) continue;

      const safeName = proveedor.toLowerCase().replace(/[^a-z0-9-]/g, '-');

      // Alarma: mensajes en DLQ (indica fallos definitivos)
      const dlqAlarm = new cloudwatch.Alarm(this, `DLQAlarm-${proveedor}`, {
        alarmName: `tapi-dlq-mensajes-${safeName}-${environment}`,
        alarmDescription: `DLQ de ${proveedor} tiene mensajes — registros no procesados`,
        metric: new cloudwatch.Metric({
          namespace: 'AWS/SQS',
          metricName: 'ApproximateNumberOfMessagesVisible',
          dimensionsMap: { QueueName: dlq.queueName },
          period: cdk.Duration.minutes(5),
          statistic: 'Sum',
        }),
        threshold: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        evaluationPeriods: 1,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
      alarms.push(dlqAlarm);

      // Alarma: tasa de errores del worker > 5%
      const workerErrorRateAlarm = new cloudwatch.Alarm(this, `WorkerErrorRate-${proveedor}`, {
        alarmName: `tapi-worker-error-rate-${safeName}-${environment}`,
        alarmDescription: `Tasa de error del worker ${proveedor} supera el 5%`,
        metric: new cloudwatch.MathExpression({
          expression: 'errors / MAX([errors, invocations]) * 100',
          usingMetrics: {
            errors: workerFn.metricErrors({ period: cdk.Duration.minutes(15), statistic: 'Sum' }),
            invocations: workerFn.metricInvocations({
              period: cdk.Duration.minutes(15),
              statistic: 'Sum',
            }),
          },
        }),
        threshold: 5,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        evaluationPeriods: 2,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      });
      alarms.push(workerErrorRateAlarm);
    }

    // Suscribir todas las alarmas al topic de SNS
    const snsAction = new cloudwatchActions.SnsAction(alertTopic);
    for (const alarm of alarms) {
      alarm.addAlarmAction(snsAction);
      alarm.addOKAction(snsAction);
    }

    // Dashboard consolidado
    const dashboard = new cloudwatch.Dashboard(this, 'BatchDashboard', {
      dashboardName: `tapi-batch-${environment}`,
    });

    const workerMetrics = providers.flatMap((proveedor) => {
      const fn = workerFunctions.get(proveedor);
      if (!fn) return [];
      return [
        fn.metricInvocations({ period: cdk.Duration.minutes(5), statistic: 'Sum', label: proveedor }),
        fn.metricErrors({ period: cdk.Duration.minutes(5), statistic: 'Sum', label: `${proveedor} errors` }),
      ];
    });

    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Invocaciones y Errores por Worker',
        left: workerMetrics,
        width: 24,
      }),
      new cloudwatch.GraphWidget({
        title: 'Orquestador — Invocaciones y Errores',
        left: [
          orchestratorFunction.metricInvocations({ period: cdk.Duration.hours(1), statistic: 'Sum' }),
          orchestratorFunction.metricErrors({ period: cdk.Duration.hours(1), statistic: 'Sum' }),
        ],
        width: 12,
      }),
    );
  }
}
