// src/index.ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
// Importar todas las herramientas (playTools y readTools)
import { playTools } from "./play.js";
import { readTools } from "./read.js";

const server = new McpServer({
  name: "spotify-controller", // Nombre del servidor
  version: "1.0.0", // Versión
  capabilities: {
    // Declarar las capacidades que soportará
    tools: { listChanged: true }, // Soportamos herramientas, y podríamos notificar cambios si las añadiéramos/quitáramos dinámicamente
    // resources: {}, // Si planeas añadir recursos, decláralo aquí
    // prompts: {}, // Si planeas añadir prompts, decláralo aquí
    // logging: {}, // Si quieres usar logging estructurado, decláralo aquí
  },
});

// Combinar todas las herramientas en una sola lista
const allTools = [...readTools, ...playTools];

// Registrar cada herramienta en el servidor MCP
allTools.forEach((tool) => {
  // Usar el método tool del servidor para registrar cada herramienta
  // El SDK se encarga de convertir el esquema Zod a JSON Schema
  server.tool(tool.name, tool.description, tool.schema, tool.handler);
  console.error(`Registered tool: ${tool.name}`); // Log a stderr para depuración
});

async function main() {
  // Crear e iniciar el transporte stdio
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Servidor MCP Spotify Controller ejecutándose en stdio."); // Log a stderr

  // Mantener el proceso vivo hasta que el transporte se cierre
  await new Promise<void>((resolve) => {
    transport.onclose = resolve;
    process.stdin.on("end", () => transport.close());
  });

  console.error("Servidor MCP Spotify Controller cerrando."); // Log a stderr
}

// Ejecutar la función principal y manejar errores
main().catch((error) => {
  console.error("Fatal error in main():", error); // Log errores a stderr
  process.exit(1); // Salir con código de error
});
