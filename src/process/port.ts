import { createServer } from "node:net";

export async function assertPortAvailable(
  host: string,
  port: number,
  serviceName: string,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const server = createServer();
    server.once("error", () => {
      reject(new Error(`${serviceName} port ${host}:${port} is already in use`));
    });
    server.listen(port, host, () => {
      server.close((error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  });
}
