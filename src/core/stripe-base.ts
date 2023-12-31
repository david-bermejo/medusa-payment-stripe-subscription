import { 
    AbstractPaymentProcessor,
    Cart,
    CartService,
    isPaymentProcessorError,
    MedusaContainer,
    PaymentProcessorContext,
    PaymentProcessorError,
    PaymentProcessorSessionResponse,
    PaymentSessionStatus,
} from "@medusajs/medusa"
import { EOL } from "os"
import Stripe from "stripe"
import {
    ErrorCodes,
    ErrorIntentStatus,
    PaymentIntentOptions,
    StripeOptions,
} from "../types/stripe"
import { MedusaError } from "@medusajs/utils"
import { SUBSCRIPTION_TYPE_ID } from "../types/constants"

abstract class StripeBase extends AbstractPaymentProcessor {
    static identifier = ""

    protected readonly options_: StripeOptions
    protected stripe_: Stripe
    protected cartService: CartService

    protected constructor(container, options) {
        super(container, options)

        this.cartService = container.cartService as CartService
        this.options_ = options
        
        this.init()
    }

    protected init(): void {
        this.stripe_ = this.stripe_ ||
            new Stripe(this.options_.api_key, {
                apiVersion: "2023-10-16"
            })
    }

    abstract get paymentIntentOptions(): PaymentIntentOptions

    getStripe() {
        return this.stripe_
    }

    getPaymentIntentOptions(): PaymentIntentOptions {
        const options: PaymentIntentOptions = {}
    
        if (this?.paymentIntentOptions?.capture_method) {
            options.capture_method = this.paymentIntentOptions.capture_method
        }
    
        if (this?.paymentIntentOptions?.setup_future_usage) {
            options.setup_future_usage = this.paymentIntentOptions.setup_future_usage
        }
    
        if (this?.paymentIntentOptions?.payment_method_types) {
            options.payment_method_types =
                this.paymentIntentOptions.payment_method_types
        }
    
        return options
    }

    async capturePayment(
        paymentSessionData: Record<string, unknown>
    ): Promise<
        PaymentProcessorError | PaymentProcessorSessionResponse["session_data"]
    > {
        const id = paymentSessionData.id as string
        try {
            const intent = await this.stripe_.paymentIntents.capture(id)
            return intent as unknown as PaymentProcessorSessionResponse["session_data"]
        } catch (error) {
            if (error.code === ErrorCodes.PAYMENT_INTENT_UNEXPECTED_STATE) {
                if (error.payment_intent?.status === ErrorIntentStatus.SUCCEEDED) {
                    return error.payment_intent
                }
            }

            return this.buildError("An error occurred in capturePayment", error)
        }
    }

    async authorizePayment(
        paymentSessionData: Record<string, unknown>, 
        context: Record<string, unknown>
    ): Promise<
        PaymentProcessorError | 
        { 
            status: PaymentSessionStatus; 
            data: PaymentProcessorSessionResponse["session_data"]; 
        }
    > {
        const status = await this.getPaymentStatus(paymentSessionData)
        return { data: paymentSessionData, status }
    }

    async cancelPayment(
        paymentSessionData: Record<string, unknown>
    ): Promise<
        PaymentProcessorError | PaymentProcessorSessionResponse["session_data"]
    > {
        try {
            const id = paymentSessionData.id as string
            return (await this.stripe_.paymentIntents.cancel(
                id
            )) as unknown as PaymentProcessorSessionResponse["session_data"]
        } catch (error) {
            if (error.payment_intent?.status === ErrorIntentStatus.CANCELED) {
                return error.payment_intent
            }
    
            return this.buildError("An error occurred in cancelPayment", error)
        }
    }

    async initiatePayment(
        context: PaymentProcessorContext
    ): Promise<PaymentProcessorError | PaymentProcessorSessionResponse> {
        const intentRequestData = this.getPaymentIntentOptions()
        const {
            email,
            context: cart_context,
            currency_code,
            amount,
            resource_id,
            billing_address,
            customer,
        } = context

        // Create address object
        let address
        if (billing_address) {
            address = {
                line1: billing_address.address_1,
                line2: billing_address.address_2,
                city: billing_address.city,
                country: billing_address.country_code,
                postal_code: billing_address.postal_code
            }
        }

        // Check description
        const description = (cart_context.payment_description ??
            this.options_?.payment_description) as string
        
        // Check if Stripe customer exists
        let customer_id = customer?.metadata?.stripe_id as string | undefined
        if (customer_id) {
            try {
                const stripeCustomer = await this.stripe_.customers.retrieve(customer_id)
                customer_id = stripeCustomer.id
            } catch (err) {
                customer_id = undefined
            }
        }

        if (!customer_id) {
            let stripeCustomer: Stripe.Customer
            try {
                stripeCustomer = await this.stripe_.customers.create({
                    name: `${customer?.first_name} ${customer?.last_name}`,
                    phone: customer?.phone,
                    email,
                    address
                })
            } catch (e) {
                return this.buildError(
                    "An error occurred in InitiatePayment when creating a Stripe customer",
                    e
                )
            }
            customer_id = stripeCustomer.id
            console.log("Customer:", stripeCustomer)
        }

        const cart = await this.cartService.retrieve(resource_id, {
            relations: ["items", "items.variant", "items.variant.product"]
        })

        const subscriptionItems = cart.items
            .filter((item) => item.variant.product.type_id === SUBSCRIPTION_TYPE_ID)
        
        // Only allow one item
        if (subscriptionItems.length > 1) {
            return this.buildError(
                "An error occurred in InitiatePayment during the subscription items obtention",
                new Error("Only one subscription item is allowed")
            )
        }

        const subscriptionItem = subscriptionItems[0]
        console.log(subscriptionItem)

        let subscription: Stripe.Subscription
        try {
            subscription = await this.stripe_.subscriptions.create({
                customer: customer_id,
                items: [{
                    price: subscriptionItem.variant.metadata?.price_id as string,
                    quantity: subscriptionItem.quantity
                }],
                description,
                payment_behavior: 'default_incomplete',
                payment_settings: { save_default_payment_method: 'on_subscription' },
                expand: ['latest_invoice.payment_intent'],
                metadata: {
                    customer_id: customer?.id || null,
                    product_id: subscriptionItem.variant.product_id
                }
            })
            console.log("Customer:", subscription)
        } catch (e) {
            return this.buildError(
                "An error occurred in InitiatePayment during the creation of the stripe subscription object",
                e
            )
        }

        const paymentIntent = (subscription.latest_invoice as Stripe.Invoice).payment_intent as Stripe.PaymentIntent
        const session_data = await this.stripe_.paymentIntents.update(paymentIntent.id, {
            metadata: {
                resource_id,
                subscription_id: subscription.id,
            }
        }) as unknown as Record<string, unknown>

        return {
            session_data,
            update_requests: customer?.metadata?.stripe_id === customer_id
                ? undefined
                : {
                    customer_metadata: {
                        stripe_id: customer_id,
                    },
                },
        }
    }

    async deletePayment(
        paymentSessionData: Record<string, unknown>
    ): Promise<
        PaymentProcessorError | PaymentProcessorSessionResponse["session_data"]
    > {
        return await this.cancelPayment(paymentSessionData)
    }

    async getPaymentStatus(
        paymentSessionData: Record<string, unknown>
    ): Promise<PaymentSessionStatus> {
        const id = paymentSessionData.id as string
        const paymentIntent = await this.stripe_.paymentIntents.retrieve(id)

        switch (paymentIntent.status) {
            case "requires_payment_method":
            case "requires_confirmation":
            case "processing":
                return PaymentSessionStatus.PENDING
            case "requires_action":
                return PaymentSessionStatus.REQUIRES_MORE
            case "canceled":
                return PaymentSessionStatus.CANCELED
            case "requires_capture":
            case "succeeded":
                return PaymentSessionStatus.AUTHORIZED
            default:
                return PaymentSessionStatus.PENDING
        }
    }

    async refundPayment(
        paymentSessionData: Record<string, unknown>, 
        refundAmount: number
    ): Promise<
        PaymentProcessorError | PaymentProcessorSessionResponse["session_data"]
    > {
        const id = paymentSessionData.id as string

        try {
            await this.stripe_.refunds.create({
                amount: Math.round(refundAmount),
                payment_intent: id as string,
            })
        } catch (e) {
            return this.buildError("An error occurred in refundPayment", e)
        }

        return paymentSessionData
    }

    async retrievePayment(
        paymentSessionData: Record<string, unknown>
    ): Promise<
        PaymentProcessorError | PaymentProcessorSessionResponse["session_data"]
    > {
        try {
            const id = paymentSessionData.id as string
            const intent = await this.stripe_.paymentIntents.retrieve(id)
            return intent as unknown as PaymentProcessorSessionResponse["session_data"]
        } catch (e) {
            return this.buildError("An error occurred in retrievePayment", e)
        }
    }

    async updatePayment(
        context: PaymentProcessorContext
    ): Promise<PaymentProcessorError | PaymentProcessorSessionResponse | void> {
        const {
            amount,
            customer,
            resource_id,
            paymentSessionData,
            context: cart_context
        } = context
        
        const stripeId = customer?.metadata?.stripe_id

        if (stripeId !== paymentSessionData.customer) {
            const result = await this.initiatePayment(context)
            
            if (isPaymentProcessorError(result)) {
                return this.buildError(
                    "An error occurred in updatePayment during the initiate of the new payment for the new customer",
                    result
                )
            }

            return result
        } else {
            if (amount && paymentSessionData.amount === Math.round(amount)) {
                return
            }

            try {
                // Apply discounts
                const subscription_id = (paymentSessionData.metadata as any).subscription_id as string

                console.log(cart_context)
                if (!cart_context.promo_id)
                    return
                
                const updatedSubscription = await this.stripe_.subscriptions.update(subscription_id, {
                    promotion_code: cart_context.promo_id as string,
                    expand: ['latest_invoice.payment_intent'],
                })

                const sessionData = (updatedSubscription.latest_invoice as Stripe.Invoice).payment_intent as unknown as Record<string, unknown>

                return { session_data: sessionData }
            } catch (e) {
                return this.buildError("An error occurred in updatePayment", e)
            }
        }
    }

    async updatePaymentData(sessionId: string, data: Record<string, unknown>) {
        try {
            // Prevent from updating the amount from here as it should go through
            // the updatePayment method to perform the correct logic
            if (data.amount) {
                throw new MedusaError(
                    MedusaError.Types.INVALID_DATA,
                    "Cannot update amount, use updatePayment instead"
                )
            }
    
            return (await this.stripe_.paymentIntents.update(sessionId, {
                ...data,
            })) as unknown as PaymentProcessorSessionResponse["session_data"]
        } catch (e) {
            return this.buildError("An error occurred in updatePaymentData", e)
        }
    }

    /**
     * Constructs Stripe Webhook event
     * @param {object} data - the data of the webhook request: req.body
     * @param {object} signature - the Stripe signature on the event, that
     *    ensures integrity of the webhook event
     * @return {object} Stripe Webhook event
     */
    constructWebhookEvent(data, signature) {
        return this.stripe_.webhooks.constructEvent(
            data,
            signature,
            this.options_.webhook_secret
        )
    }
    protected buildError(
        message: string,
        e: Stripe.StripeRawError | PaymentProcessorError | Error
    ): PaymentProcessorError {
        return {
        error: message,
        code: "code" in e ? e.code : "",
        detail: isPaymentProcessorError(e)
            ? `${e.error}${EOL}${e.detail ?? ""}`
            : "detail" in e
            ? e.detail
            : e.message ?? "",
        }
    }
}

export default StripeBase