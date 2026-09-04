import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  eslint: { ignoreDuringBuilds: false },
  // Prisma must stay external to the server bundle so the query engine binary resolves.
  serverExternalPackages: ["@prisma/client", ".prisma/client"],
};

export default nextConfig;
