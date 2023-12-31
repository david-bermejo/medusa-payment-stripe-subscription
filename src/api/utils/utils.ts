import {
    AbstractCartCompletionStrategy,
    CartService,
    IdempotencyKeyService,
    PostgresError,
} from "@medusajs/medusa"
import { AwilixContainer } from "awilix"
import { MedusaError } from "medusa-core-utils"
import { EOL } from "os"
import Stripe from "stripe"
import StripeBase from "../../core/stripe-base"
import { getNextValidDate } from "./getNextValidDate"

const PAYMENT_PROVIDER_KEY = "pp_stripe"

export function constructWebhook({
    signature,
    body,
    container,
}: {
    signature: string | string[] | undefined
    body: any
    container: AwilixContainer
}): Stripe.Event {
    const stripeProviderService = container.resolve(PAYMENT_PROVIDER_KEY)
    return stripeProviderService.constructWebhookEvent(body, signature)
}

export function isPaymentCollection(id) {
    return id && id.startsWith("paycol")
}

export function buildError(event: string, err: Stripe.StripeRawError): string {
    let message = `Stripe webhook ${event} handling failed${EOL}${
        err?.detail ?? err?.message
    }`
    if (err?.code === PostgresError.SERIALIZATION_FAILURE) {
        message = `Stripe webhook ${event} handle failed. This can happen when this webhook is triggered during a cart completion and can be ignored. This event should be retried automatically.${EOL}${
            err?.detail ?? err?.message
        }`
    }
    if (err?.code === "409") {
        message = `Stripe webhook ${event} handle failed.${EOL}${
            err?.detail ?? err?.message
        }`
    }

    return message
}

export async function handlePaymentHook({
    event,
    container,
    paymentIntent,
}: {
    event: { type: string; id: string }
    container: AwilixContainer
    paymentIntent: {
        id: string
        metadata: { cart_id?: string; resource_id?: string }
        last_payment_error?: { message: string }
    }
}): Promise<{ statusCode: number }> {
    const logger = container.resolve("logger")

    const cartId =
        paymentIntent.metadata.cart_id ?? paymentIntent.metadata.resource_id // Backward compatibility
    const resourceId = paymentIntent.metadata.resource_id

    switch (event.type) {
        case "customer.subscription.deleted":
            try {
                await onSubscriptionDeleted({
                    subscription: paymentIntent,
                    container
                })
            } catch (err) {
                const message = buildError(event.type, err)
                logger.warn(message)
                return { statusCode: 409 }
            }

            break
        case "invoice.payment_succeeded":
            try {
                await onInvoicePaymentSucceeded({
                    invoice: paymentIntent,
                    container
                })
            } catch (err) {
                const message = buildError(event.type, err)
                logger.warn(message)
                return { statusCode: 409 }
            }

            break
        case "invoice.payment_failed":
            try {
                await onInvoicePaymentFailed({
                    invoice: paymentIntent,
                    container
                })
            } catch (err) {
                const message = buildError(event.type, err)
                logger.warn(message)
                return { statusCode: 409 }
            }

            break
        case "payment_intent.succeeded":
            try {
                await onPaymentIntentSucceeded({
                    eventId: event.id,
                    paymentIntent,
                    cartId,
                    resourceId,
                    isPaymentCollection: isPaymentCollection(resourceId),
                    container,
                })
            } catch (err) {
                const message = buildError(event.type, err)
                logger.warn(message)
                return { statusCode: 409 }
            }

            break
        case "payment_intent.amount_capturable_updated":
            try {
                await onPaymentAmountCapturableUpdate({
                    eventId: event.id,
                    cartId,
                    container,
                })
            } catch (err) {
                const message = buildError(event.type, err)
                logger.warn(message)
                return { statusCode: 409 }
            }

            break
        case "payment_intent.payment_failed":
            const message =
                paymentIntent.last_payment_error &&
                paymentIntent.last_payment_error.message
            logger.error(
                `The payment of the payment intent ${paymentIntent.id} has failed${EOL}${message}`
            )
            break
        default:
            return { statusCode: 204 }
    }

    return { statusCode: 200 }
}

async function onSubscriptionDeleted({
    subscription,
    container
}) {
    const subscriptionService = container.resolve("subscriptionService")

    await subscriptionService.delete(subscription.id)
}

async function onInvoicePaymentFailed({
    invoice,
    container,
}) {
    const manager = container.resolve("manager")
    const subscriptionService = container.resolve("subscriptionService")

    await manager.transaction(async (transactionManager) => {
        const subscription = await subscriptionService
            .withTransaction(transactionManager)
            .retrieveByStripeSubscriptionId(invoice.subscription)
            .catch(() => undefined)
        
        if (subscription) {
            await onSubscriptionUpdate({
                invoice,
                container,
                subscription,
                transactionManager
            })
        }
    })
}

async function onInvoicePaymentSucceeded({
    invoice,
    container,
}) {
    const manager = container.resolve("manager")
    const subscriptionService = container.resolve("subscriptionService")

    await manager.transaction(async (transactionManager) => {
        const subscription = await subscriptionService
            .withTransaction(transactionManager)
            .retrieveByStripeSubscriptionId(invoice.subscription)
            .catch(() => undefined)
        
        if (subscription) {
            await onSubscriptionUpdate({
                invoice,
                container,
                subscription,
                transactionManager
            })
        } else {
            await onSubscriptionCreate({
                invoice,
                container,
                transactionManager
            })
        }
    })
}

async function onSubscriptionCreate({
    invoice,
    container,
    transactionManager,
}) {
    const subscriptionService = container.resolve("subscriptionService")
    const laundryOrderService = container.resolve("laundryOrderService")
    const stripeBase: StripeBase = container.resolve("stripeProviderService")
    
    const stripeSubscription = await stripeBase.getStripe()
        .subscriptions.retrieve(invoice.subscription, {
            expand: ["latest_invoice"]
        })

    const payload = {
        stripe_invoice: stripeSubscription.latest_invoice,
        stripe_subscription_id: stripeSubscription.id,
        status: getSubscriptionStatus(stripeSubscription.status),
        current_period_start: new Date(stripeSubscription.current_period_start * 1000),
        current_period_end: new Date(stripeSubscription.current_period_end * 1000),
        product_id: stripeSubscription.metadata.product_id,
        customer_id: stripeSubscription.metadata.customer_id
    }

    const subscription = await subscriptionService
        .withTransaction(transactionManager)
        .create(payload)
    
    // Create first laundry order
    await laundryOrderService
        .withTransaction(transactionManager)
        .create({
            subscription_id: subscription.id,
            customer_id: subscription.customer_id,
            address_id: subscription.customer.metadata.default_shipping_address_id as string,
            placed_at: getNextValidDate(new Date())
        })
}

async function onSubscriptionUpdate({
    invoice,
    container,
    subscription,
    transactionManager,
}) {
    const subscriptionService = container.resolve("subscriptionService")
    const stripeBase: StripeBase = container.resolve("stripeProviderService")

    const stripeSubscription = await stripeBase.getStripe()
        .subscriptions.retrieve(invoice.subscription)

    const payload = {
        status: getSubscriptionStatus(stripeSubscription.status),
        current_period_start: new Date(stripeSubscription.current_period_start * 1000),
        current_period_end: new Date(stripeSubscription.current_period_end * 1000),
    }

    await subscriptionService
        .withTransaction(transactionManager)
        .update(subscription.id, payload)
}

async function onPaymentIntentSucceeded({
    eventId,
    paymentIntent,
    cartId,
    resourceId,
    isPaymentCollection,
    container,
}) {
    if (!resourceId && !cartId)
        return

    const manager = container.resolve("manager")

    await manager.transaction(async (transactionManager) => {
        if (isPaymentCollection) {
            await capturePaymenCollectionIfNecessary({
                paymentIntent,
                resourceId,
                container,
            })
        } else {
            await completeCartIfNecessary({
                eventId,
                cartId,
                container,
                transactionManager,
            })

            await capturePaymentIfNecessary({
                cartId,
                transactionManager,
                container,
            })
        }
    })
}

async function onPaymentAmountCapturableUpdate({ eventId, cartId, container }) {
    const manager = container.resolve("manager")

    await manager.transaction(async (transactionManager) => {
        await completeCartIfNecessary({
            eventId,
            cartId,
            container,
            transactionManager,
        })
    })
}

async function capturePaymenCollectionIfNecessary({
    paymentIntent,
    resourceId,
    container,
}) {
    const manager = container.resolve("manager")
    const paymentCollectionService = container.resolve("paymentCollectionService")

    const paycol = await paymentCollectionService
        .retrieve(resourceId, { relations: ["payments"] })
        .catch(() => undefined)

    if (paycol?.payments?.length) {
        const payment = paycol.payments.find(
            (pay) => pay.data.id === paymentIntent.id
        )

        if (payment && !payment.captured_at) {
            await manager.transaction(async (manager) => {
                await paymentCollectionService
                    .withTransaction(manager)
                    .capture(payment.id)
            })
        }
    }
}

async function capturePaymentIfNecessary({
    cartId,
    transactionManager,
    container,
}) {
    const orderService = container.resolve("orderService")
    const order = await orderService
        .withTransaction(transactionManager)
        .retrieveByCartId(cartId)
        .catch(() => undefined)

    if (order && order.payment_status !== "captured") {
        await orderService
            .withTransaction(transactionManager)
            .capturePayment(order.id)
    }
}

async function completeCartIfNecessary({
    eventId,
    cartId,
    container,
    transactionManager,
}) {
    const orderService = container.resolve("orderService")
    const order = await orderService
        .retrieveByCartId(cartId)
        .catch(() => undefined)

    if (!order) {
        const completionStrat: AbstractCartCompletionStrategy = container.resolve(
            "cartCompletionStrategy"
        )
        const cartService: CartService = container.resolve("cartService")
        const idempotencyKeyService: IdempotencyKeyService = container.resolve(
            "idempotencyKeyService"
        )

        const idempotencyKeyServiceTx =
            idempotencyKeyService.withTransaction(transactionManager)
        let idempotencyKey = await idempotencyKeyServiceTx
            .retrieve({
                request_path: "/stripe/hooks",
                idempotency_key: eventId,
            })
            .catch(() => undefined)

        if (!idempotencyKey) {
            idempotencyKey = await idempotencyKeyService
                .withTransaction(transactionManager)
                .create({
                    request_path: "/stripe/hooks",
                    idempotency_key: eventId,
                })
        }

        const cart = await cartService
            .withTransaction(transactionManager)
            .retrieve(cartId, { select: ["context"] })

        const { response_code, response_body } = await completionStrat
            .withTransaction(transactionManager)
            .complete(cartId, idempotencyKey, { ip: cart.context?.ip as string })

        if (response_code !== 200) {
            throw new MedusaError(
                MedusaError.Types.UNEXPECTED_STATE,
                response_body["message"] as string,
                response_body["code"] as string
            )
        }
    }
}

function getSubscriptionStatus(status: string): string {
    switch (status) {
        case "incomplete_expired":
            return "incomplete"
        case "trialing":
            return "active"
        case "past_due":
        case "unpaid":
            return "halted"
        default:
            return status
    }
}