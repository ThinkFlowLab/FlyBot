"""Read wrapped MCP configuration for native migration bundles."""
import json

from . import model_api

SCHEMA = '''
CREATE TABLE IF NOT EXISTS custom_mcp_servers (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 name TEXT NOT NULL, origin TEXT NOT NULL, config_blob TEXT NOT NULL,
 revision INTEGER NOT NULL, created INTEGER NOT NULL, updated INTEGER NOT NULL);
'''
WRAP = 'custom-mcp.wrap'


def secret_config(store, row):
    return json.loads(model_api.unwrap(model_api.wrapping_key(store, WRAP), row['config_blob']))
