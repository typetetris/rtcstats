declare module "rtcstats/trace-ws" {
  declare function createTracer(wsURL: string): {
    (...args: any[]): void;
    close: () => void;
    connect: () => void;
  };
  export default createTracer;
}
