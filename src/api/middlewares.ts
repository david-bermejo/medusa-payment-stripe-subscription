import type { MiddlewaresConfig } from "@medusajs/medusa"
import { raw } from "body-parser"

export const config: MiddlewaresConfig = {
    routes: [
        {
            matcher: "/stripe/hooks",
            bodyParser: false,
            middlewares: [raw({ type: "application/json" })],
        },
    ],
}