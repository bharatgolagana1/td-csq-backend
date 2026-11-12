// What sampling listens to. Called once per process by the registry.
import { on } from '../../core/events.js';

import { releaseDeletedCustomer } from './sampling.service.js';

export function registerSamplingHandlers(): void {
  // Inside the customer-delete transaction: drop the customer from open selections, or refuse while it is locked in.
  on('customer.deleted', 'sampling.onCustomerDeleted', async (payload, meta) => {
    await releaseDeletedCustomer(payload, meta.session);
  });
}
