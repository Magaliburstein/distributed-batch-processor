export function generateIdempotencyKey(idRegistro: string, date: string): string {
  return `${idRegistro}#${date}`;
}

export function getCurrentDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export function buildDynamoPk(proveedor: string, idRegistro: string): string {
  return `${proveedor}#${idRegistro}`;
}
