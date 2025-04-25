import { authorizeSpotify, loadSpotifyConfig } from "./utils.js"; // Importar loadSpotifyConfig

console.error("Starting Spotify authentication flow..."); // Log a stderr
try {
  // Cargar la config primero para validar el archivo existe y redirectUri es localhost
  loadSpotifyConfig();
  authorizeSpotify()
    .then(() => {
      console.error("Authentication completed successfully!"); // Log a stderr
      process.exit(0);
    })
    .catch((error) => {
      console.error("Authentication failed:", error); // Log a stderr
      process.exit(1);
    });
} catch (error) {
  console.error("Configuration error:", error); // Log a stderr si falla la carga de config
  process.exit(1);
}
