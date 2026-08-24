import { redirect } from "react-router";

/**
 * The bare domain.
 *
 * A splat route (`*`) does not match `/`, so without an explicit index the
 * root path matched nothing and rendered a blank page. Shoppers always arrive
 * on `/r/<slug>` from a link the store sent them, so anyone typing the domain
 * directly is staff — send them to the dashboard, which bounces to the login
 * screen if they have no session.
 */
export function clientLoader() {
  throw redirect("/admin");
}

export default function Home() {
  return null;
}
