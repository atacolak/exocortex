/** One HTTP-mappable failure raised by the overlay host halves. */
export class OverlayError extends Error {
  constructor(status, code, message, details = {}) {
    super(message)
    this.name = 'OverlayError'
    this.status = status
    this.code = code
    this.details = details
  }
}
