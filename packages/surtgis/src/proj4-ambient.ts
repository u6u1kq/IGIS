declare module "proj4" {
  interface Projector {
    (from: string, to: string, coordinate: readonly number[]): number[];
    defs(name: string, projection: string): void;
    /** 解析 WKT 或 proj 串。只读取 datumCode 与 datum_params，不执行变换。 */
    Proj(definition: string): { datumCode?: string; datum_params?: readonly unknown[] };
  }
  const proj4: Projector;
  export default proj4;
}
