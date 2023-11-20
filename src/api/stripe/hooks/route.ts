import {
    MedusaRequest,
    MedusaResponse
} from "@medusajs/medusa"
import { constructWebhook, handlePaymentHook } from "../../utils/utils"

export const POST = async (req: MedusaRequest, res: MedusaResponse) => {
    let event
    try {
        event = constructWebhook({
            signature: req.headers["stripe-signature"],
            body: req.body,
            container: req.scope
        })
    } catch (err) {
        res.status(400).send(`Webhook Error: ${err.message}`)
        return
    }

    const paymentIntent = event.data.object

    const { statusCode } = await handlePaymentHook({
        event,
        container: req.scope,
        paymentIntent,
    })
    res.sendStatus(statusCode)
}