#!/bin/sh
# Creates the production realm "puet" for PUET.Pulse in an empty Keycloak:
# client "puet-pulse" (confidential, PKCE S256, no direct grants), the AMR
# mapper and the pwd / otp references the API reads to recognise MFA, brute
# force protection and a strong password policy. Safe to run once; it stops
# if the realm already exists. Users come from AD / LDAP federation, which you
# add in the admin console afterwards (docs/SERVER_SETUP.md, step 9).
#
# Run inside the Keycloak container:
#   docker compose -f docker-compose.yml -f infra/single-server/docker-compose.server.yml \
#     exec -e KC_ADMIN_PASSWORD -e PULSE_HOST -e OIDC_CLIENT_SECRET keycloak \
#     sh /opt/pulse/configure-realm.sh
set -eu

: "${PULSE_HOST:?set PULSE_HOST, e.g. pulse.puet.edu.ua}"
: "${OIDC_CLIENT_SECRET:?set OIDC_CLIENT_SECRET (openssl rand -hex 32)}"
: "${KC_ADMIN_PASSWORD:?set KC_ADMIN_PASSWORD (the bootstrap admin password)}"
KCADM="${KCADM:-/opt/keycloak/bin/kcadm.sh}"
SERVER="${KC_SERVER:-http://localhost:8080}"

"$KCADM" config credentials --server "$SERVER" --realm master --user "${KC_ADMIN_USER:-kcadmin}" --password "$KC_ADMIN_PASSWORD" >/dev/null

if "$KCADM" get realms/puet >/dev/null 2>&1; then
  echo "Realm puet already exists; nothing changed."
  exit 0
fi

"$KCADM" create realms -s realm=puet -s enabled=true -s 'displayName=ПУЕТ' \
  -s internationalizationEnabled=true -s 'supportedLocales=["uk","en"]' -s defaultLocale=uk \
  -s registrationAllowed=false -s resetPasswordAllowed=true -s rememberMe=false \
  -s bruteForceProtected=true -s failureFactor=10 -s sslRequired=external \
  -s 'passwordPolicy=length(12) and notUsername and notEmail and passwordHistory(5)' \
  -s ssoSessionIdleTimeout=1800 -s ssoSessionMaxLifespan=36000

CID=$("$KCADM" create clients -r puet -i \
  -s clientId=puet-pulse -s name=PUET.Pulse -s enabled=true -s publicClient=false \
  -s "secret=$OIDC_CLIENT_SECRET" -s standardFlowEnabled=true -s implicitFlowEnabled=false \
  -s directAccessGrantsEnabled=false -s serviceAccountsEnabled=false \
  -s "redirectUris=[\"https://$PULSE_HOST/api/auth/callback\"]" \
  -s "webOrigins=[\"https://$PULSE_HOST\"]" \
  -s "attributes={\"pkce.code.challenge.method\":\"S256\",\"post.logout.redirect.uris\":\"https://$PULSE_HOST/*\"}")

"$KCADM" create "clients/$CID/protocol-mappers/models" -r puet \
  -s name=amr -s protocol=openid-connect -s protocolMapper=oidc-amr-mapper \
  -s 'config={"id.token.claim":"true","access.token.claim":"true","introspection.token.claim":"true"}' >/dev/null

# The AMR mapper reports the reference configured on each step that ran.
"$KCADM" get authentication/flows/browser/executions -r puet --format csv --noquotes --fields id,providerId |
  while IFS=, read -r id provider; do
    case "$provider" in
      auth-username-password-form) ref=pwd ;;
      auth-otp-form) ref=otp ;;
      webauthn-authenticator) ref=hwk ;;
      *) continue ;;
    esac
    "$KCADM" create "authentication/executions/$id/config" -r puet \
      -b "{\"alias\":\"amr-$ref\",\"config\":{\"default.reference.value\":\"$ref\",\"default.reference.maxAge\":\"36000\"}}" >/dev/null
  done

echo "Realm puet created. Client puet-pulse redirects to https://$PULSE_HOST/api/auth/callback."
