import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';

interface StackPersistenciaProps extends cdk.StackProps {
  environment: string;
}

export class StackPersistencia extends cdk.Stack {
  readonly resultsTable: dynamodb.Table;
  readonly configTable: dynamodb.Table;

  constructor(scope: Construct, id: string, props: StackPersistenciaProps) {
    super(scope, id, props);

    const { environment } = props;

    // Tabla de resultados por ejecución
    // PK: proveedor#id_registro — distribuye escrituras entre proveedores para evitar hot partitions
    // SK: timestamp_ejecucion — permite consultar historial de reintentos de un mismo registro
    this.resultsTable = new dynamodb.Table(this, 'ResultadosTable', {
      tableName: `tapi-resultados-${environment}`,
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: 'ttl',
      removalPolicy: environment === 'prod'
        ? cdk.RemovalPolicy.RETAIN
        : cdk.RemovalPolicy.DESTROY,
      pointInTimeRecovery: environment === 'prod',
    });

    // Tabla de configuración por proveedor (clasificación de errores custom)
    this.configTable = new dynamodb.Table(this, 'ConfiguracionProveedoresTable', {
      tableName: `tapi-configuracion-proveedores-${environment}`,
      partitionKey: { name: 'proveedor', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    new cdk.CfnOutput(this, 'ResultsTableName', { value: this.resultsTable.tableName });
    new cdk.CfnOutput(this, 'ConfigTableName', { value: this.configTable.tableName });
  }
}
