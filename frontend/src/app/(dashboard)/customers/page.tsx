import { CustomerDirectory } from './_components/customer-directory';

/**
 * /customers — the Customer 360 directory (issue #134). Thin composition
 * over the testable screen component so tests can inject the client
 * deterministically.
 */
export default function CustomersPage() {
  return <CustomerDirectory />;
}
