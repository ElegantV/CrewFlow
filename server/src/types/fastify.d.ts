import "@fastify/jwt";

declare module "@fastify/jwt" {
  interface FastifyJWT {
    payload: {
      sub: string;
      role: "user" | "admin" | "super_admin";
      status: "pending" | "active" | "disabled";
    };
    user: {
      sub: string;
      role: "user" | "admin" | "super_admin";
      status: "pending" | "active" | "disabled";
    };
  }
}

declare module "fastify" {
  interface FastifyRequest {
    actor?: {
      id: string;
      role: "user" | "admin" | "super_admin";
      status: "pending" | "active" | "disabled";
      managerId: string | null;
      agentUserId: string | null;
      personnelType: "bank" | "digital" | "vendor";
    };
  }
}
