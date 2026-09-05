import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Prisma must stay external to the server bundle so the query engine binary
  // resolves at runtime.
  serverExternalPackages: ["@prisma/client", ".prisma/client"],
};

export default nextConfig;
