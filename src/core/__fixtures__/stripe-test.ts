import StripeBase from "../stripe-base"
import { PaymentIntentOptions } from "../../types/stripe"

export class StripeTest extends StripeBase {
  constructor(_, options) {
    super(_, options)
  }

  get paymentIntentOptions(): PaymentIntentOptions {
    return {}
  }
}
