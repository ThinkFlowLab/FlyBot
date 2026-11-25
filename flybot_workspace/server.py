"""Loopback-only development WSGI runner, not an internet-facing production server."""
import argparse
import socketserver
from wsgiref.simple_server import WSGIRequestHandler, WSGIServer, make_server

from .app import App, Config
from .store import Store
from .lifecycle import Lifecycle, RuntimePolicy
from .operator_config import load_auto_provision, load_manager_auth, load_operator_admin
from .oidc import load_oidc_providers
from .settings_page import SettingsPage
from .model_http_policy import load_model_http_policy


class QuietHandler(WSGIRequestHandler):
    def setup(self):
        super().setup()
        self.connection.settimeout(5)

    def log_message(self, format, *args):
        # Do not write URLs, queries, cookies or bodies to request logs.
        pass


class ThreadedWSGIServer(socketserver.ThreadingMixIn, WSGIServer):
    """Allow overlapping asset and API requests on the loopback runner.

    This is still not an internet-facing production server.
    """
    daemon_threads = True
    block_on_close = False


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data-dir', required=True)
    parser.add_argument('--origin', required=True)
    parser.add_argument('--port', type=int, default=8080)
    parser.add_argument('--insecure-local', action='store_true')
    parser.add_argument('--open-registration', action='store_true')
    parser.add_argument('--simulation', action='store_true', help='Enable explicitly labelled simulation lifecycle APIs; never runs Docker')
    parser.add_argument('--compose-image', help='Explicit Compose execution profile; operator-supplied image@sha256 digest, never pulled by Web')
    parser.add_argument('--manager-grants', help='Operator-owned private JSON file containing manager credential digests and explicit instance grants')
    parser.add_argument('--operator-admin', help='Operator-owned private JSON file with a credential_hash for admin APIs (platform model API)')
    parser.add_argument('--model-http-policy', help='Private operator file of exact public IPv4 HTTP task-model bases; HTTPS default unchanged')
    parser.add_argument('--oidc-providers', help='Operator-owned private JSON file of OIDC/OAuth client credentials; secrets are never logged')
    parser.add_argument('--auto-provision', help='Private operator JSON enabling one capped, isolated runtime per user personal workspace (default off)')
    args = parser.parse_args()
    if args.simulation and args.compose_image:
        parser.error('Choose simulation OR explicit Compose execution')
    if args.manager_grants and not (args.simulation or args.compose_image):
        parser.error('Manager grants require an explicit runtime profile')
    if args.auto_provision and not args.manager_grants:
        parser.error('Auto-provisioning requires manager grants with an auto_provisioned manager')
    if not 1 <= args.port <= 65535:
        parser.error('Port must be in 1..65535')
    try:
        store = Store(args.data_dir)
        policy = RuntimePolicy(image_ref=args.compose_image, profile='local-compose', backend_mode='compose') if args.compose_image else RuntimePolicy()
        lifecycle = Lifecycle(store, policy) if args.simulation or args.compose_image else None
        manager_auth = load_manager_auth(args.manager_grants) if args.manager_grants else None
        operator_admin = load_operator_admin(args.operator_admin) if args.operator_admin else None
        oidc_registry = load_oidc_providers(args.oidc_providers) if args.oidc_providers else None
        http_policy = load_model_http_policy(args.model_http_policy) if args.model_http_policy else None
        auto_provision = load_auto_provision(args.auto_provision) if args.auto_provision else None
        app = App(store, Config(origin=args.origin, insecure_local=args.insecure_local,
                                allow_registration=args.open_registration), lifecycle=lifecycle, manager_auth=manager_auth, operator_admin=operator_admin, oidc_registry=oidc_registry, model_http_policy=http_policy, auto_provision=auto_provision)
    except (OSError, ValueError, TypeError):
        parser.error('Cannot initialize private storage or origin configuration')
    page = SettingsPage(app)
    # This development server binds to loopback only.
    with make_server('127.0.0.1', args.port, page, handler_class=QuietHandler, server_class=ThreadedWSGIServer) as server:
        server.serve_forever()


if __name__ == '__main__':
    main()
