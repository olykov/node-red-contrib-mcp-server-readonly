module.exports = function (RED)
{
    "use strict";

    const { createStorage, hashToken, normalizeTtl } = require('./lib/auth-storage');

    function envOrCredential(node, envName, credentialName)
    {
        const fromEnv = envName ? process.env[String(envName)] : '';
        if (fromEnv) return fromEnv;
        return node.credentials && node.credentials[credentialName] ? node.credentials[credentialName] : '';
    }

    function MCPRedisConfigNode(config)
    {
        RED.nodes.createNode(this, config);
        const node = this;
        node.name = config.name || '';
        node.mode = config.mode || 'memory';
        node.redisUrlEnv = config.redisUrlEnv || 'REDIS_URL';
        node.host = config.host || '127.0.0.1';
        node.port = Number(config.port || 6379);
        node.db = Number(config.db || 0);
        node.tls = config.tls || false;
        node.username = config.username || '';
        node.keyPrefix = config.keyPrefix || 'mcp_auth:';
        node.storage = null;

        node.createStorage = function ()
        {
            if (!node.storage)
            {
                node.storage = createStorage({
                    mode: node.mode,
                    redisUrlEnv: node.redisUrlEnv,
                    host: node.host,
                    port: node.port,
                    db: node.db,
                    tls: node.tls,
                    username: node.username,
                    password: envOrCredential(node, config.passwordEnv || '', 'password'),
                    keyPrefix: node.keyPrefix
                });
            }
            return node.storage;
        };

        node.on('close', function (done)
        {
            if (node.storage && typeof node.storage.close === 'function')
            {
                Promise.resolve(node.storage.close()).then(() => done()).catch(() => done());
            } else done();
        });
    }

    function MCPAuthConfigNode(config)
    {
        RED.nodes.createNode(this, config);
        const node = this;
        const getNode = RED.nodes && typeof RED.nodes.getNode === 'function' ? RED.nodes.getNode.bind(RED.nodes) : null;
        node.name = config.name || '';
        node.enabled = config.enabled !== false;
        node.issuerUrl = config.issuerUrl || '';
        node.clientId = config.clientId || '';
        node.clientSecretEnv = config.clientSecretEnv || '';
        node.allowedClientHosts = config.allowedClientHosts || '';
        node.baseScopes = config.baseScopes || 'openid profile email';
        node.groupClaim = config.groupClaim || 'groups';
        node.userClaim = config.userClaim || 'email';
        node.redisConfigId = config.redis || '';
        node.redisConfig = node.redisConfigId && getNode ? getNode(node.redisConfigId) : null;
        node.accessTokenTtl = normalizeTtl(config.accessTokenTtl || 3600);
        node.authCodeTtl = normalizeTtl(config.authCodeTtl || 300);
        node.stateTtl = normalizeTtl(config.stateTtl || 300);
        node.storage = null;

        node.clientSecret = function ()
        {
            return envOrCredential(node, node.clientSecretEnv, 'clientSecret');
        };

        node.getStorage = function ()
        {
            if (!node.storage)
            {
                if (!node.redisConfig || typeof node.redisConfig.createStorage !== 'function')
                {
                    throw new Error('MCP auth storage config is required');
                }
                node.storage = node.redisConfig.createStorage();
            }
            return node.storage;
        };

        node.writeAccessToken = async function (token, claims, ttlSeconds)
        {
            await node.getStorage().set('access', hashToken(token), claims, ttlSeconds || node.accessTokenTtl);
        };

        node.readAccessToken = async function (token)
        {
            return node.getStorage().get('access', hashToken(token));
        };

        node.writeState = async function (state, value, ttlSeconds)
        {
            await node.getStorage().set('state', state, value, ttlSeconds || node.stateTtl);
        };

        node.readState = async function (state)
        {
            return node.getStorage().get('state', state);
        };

        node.deleteState = async function (state)
        {
            await node.getStorage().delete('state', state);
        };

        node.writeCode = async function (code, value, ttlSeconds)
        {
            await node.getStorage().set('code', code, value, ttlSeconds || node.authCodeTtl);
        };

        node.readCode = async function (code)
        {
            return node.getStorage().get('code', code);
        };

        node.deleteCode = async function (code)
        {
            await node.getStorage().delete('code', code);
        };

        node.on('close', function (done)
        {
            done();
        });
    }

    RED.nodes.registerType('mcp-redis', MCPRedisConfigNode, {
        credentials: {
            password: { type: 'password' }
        }
    });
    RED.nodes.registerType('mcp-auth', MCPAuthConfigNode, {
        credentials: {
            clientSecret: { type: 'password' }
        }
    });
};
