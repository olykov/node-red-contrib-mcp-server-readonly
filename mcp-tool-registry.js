module.exports = function (RED)
{
    "use strict";

    function MCPToolRegistryNode(config)
    {
        RED.nodes.createNode(this, config);
        const node = this;

        // Configuration
        node.toolName = config.toolName || "";
        node.toolDescription = config.toolDescription || "";
        node.toolSchema = config.toolSchema || "{}";
        node.autoRegister = config.autoRegister !== false;

        // Runtime state
        node.isRegistered = false;

        // Set initial status
        node.status({ fill: "grey", shape: "ring", text: "unregistered" });

        // Parse tool schema
        let parsedSchema = {};
        try
        {
            parsedSchema = JSON.parse(node.toolSchema);
        } catch (error)
        {
            node.warn(`Invalid tool schema JSON: ${error.message}`);
            parsedSchema = {
                type: "object",
                properties: {},
                required: []
            };
        }

        // Register tool function
        node.registerTool = function ()
        {
            if (!node.toolName)
            {
                node.warn("Tool name is required for registration");
                return;
            }

            if (node.isRegistered)
            {
                node.warn("Tool is already registered");
                return;
            }

            const toolDefinition = {
                name: node.toolName,
                description: node.toolDescription || `Tool: ${node.toolName}`,
                inputSchema: parsedSchema,
                registeredBy: node.id,
                registrationTime: new Date()
            };

            // Emit registration event
            RED.events.emit('mcp-tool-register', toolDefinition);

            node.isRegistered = true;
            node.status({ fill: "green", shape: "dot", text: "registered" });

            node.log(`Tool "${node.toolName}" registered successfully`);

            // Send registration message
            node.send({
                topic: 'tool-registered',
                payload: {
                    toolName: node.toolName,
                    description: node.toolDescription,
                    schema: parsedSchema
                }
            });
        };

        // Unregister tool function
        node.unregisterTool = function ()
        {
            if (!node.isRegistered)
            {
                node.warn("Tool is not currently registered");
                return;
            }

            // Emit unregistration event
            RED.events.emit('mcp-tool-unregister', node.toolName);

            node.isRegistered = false;
            node.status({ fill: "grey", shape: "ring", text: "unregistered" });

            node.log(`Tool "${node.toolName}" unregistered`);

            // Send unregistration message
            node.send({
                topic: 'tool-unregistered',
                payload: {
                    toolName: node.toolName
                }
            });
        };

        // Update tool registration
        node.updateRegistration = function ()
        {
            if (node.isRegistered)
            {
                node.unregisterTool();
                setTimeout(() => node.registerTool(), 100);
            }
        };

        // Handle input messages
        node.on('input', function (msg)
        {
            const command = msg.topic || msg.payload.command;

            switch (command)
            {
                case 'register':
                    node.registerTool();
                    break;

                case 'unregister':
                    node.unregisterTool();
                    break;

                case 'update':
                    // Update tool definition from message
                    if (msg.payload.toolName) node.toolName = msg.payload.toolName;
                    if (msg.payload.toolDescription) node.toolDescription = msg.payload.toolDescription;
                    if (msg.payload.toolSchema)
                    {
                        try
                        {
                            parsedSchema = JSON.parse(msg.payload.toolSchema);
                            node.toolSchema = msg.payload.toolSchema;
                        } catch (error)
                        {
                            node.warn(`Invalid schema in update: ${error.message}`);
                        }
                    }
                    node.updateRegistration();
                    break;

                case 'status':
                    msg.payload = {
                        toolName: node.toolName,
                        isRegistered: node.isRegistered,
                        description: node.toolDescription,
                        schema: parsedSchema
                    };
                    node.send(msg);
                    break;

                default:
                    node.warn(`Unknown command: ${command}`);
            }
        });

        // Auto-register if configured
        if (node.autoRegister && node.toolName)
        {
            setTimeout(() => node.registerTool(), 500);
        }

        // Cleanup on node close
        node.on('close', function (done)
        {
            if (node.isRegistered)
            {
                node.unregisterTool();
            }
            done();
        });
    }

    // Register the node
    RED.nodes.registerType("mcp-tool-registry", MCPToolRegistryNode);
}; 
