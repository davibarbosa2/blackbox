import { createServer, type AddressInfo } from "node:net";

export async function findAvailablePort(preferredPort = 0): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(preferredPort, "127.0.0.1", () => {
      const address = server.address();
      if (address === null) {
        reject(new Error("Expected a TCP address"));
        return;
      }
      // SAFETY: Listening with a TCP host guarantees AddressInfo, not a pipe name.
      const tcpAddress = address as AddressInfo;
      server.close((error) => {
        if (error) reject(error);
        else resolve(tcpAddress.port);
      });
    });
  });
}
