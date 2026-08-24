export const LOCAL_CUSTOMER_SESSION_COOKIE = "cso_local_customer_session";

export type CustomerSession = {
  authenticationMode: "local" | "cognito";
};

export function isLocalAuthenticationEnabled(input: {
  nodeEnv: string | undefined;
  localCustomerToken: string | undefined;
}) {
  return input.nodeEnv === "development" && Boolean(input.localCustomerToken);
}
