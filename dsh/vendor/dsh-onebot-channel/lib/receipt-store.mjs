import { DATA_DIR } from './env.js'
import { ProactiveReceiptStore } from '../receipt-transaction.mjs'

export const receiptStore = new ProactiveReceiptStore({ file: `${DATA_DIR}/qq-proactive-receipts.json` })
