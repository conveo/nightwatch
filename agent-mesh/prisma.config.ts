// Prisma config for the mobile console's own SQLite database.
//
// Kept inside agent-mesh on purpose: this database has nothing to do with any other
// app's, and a config of its own stops a console migration ever being pointed at
// another app's database by accident.
import { defineConfig } from "prisma/config"
import { consoleDatabaseUrl } from "./src/console-db-url.js"

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: { path: "prisma/migrations" },
  datasource: { url: consoleDatabaseUrl() },
})
