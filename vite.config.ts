import { validateHybridPalette } from "./src/dev/hybrid_palette";
import { defaultAudioComparison, validateAudioComparison } from "./src/dev/audio_color_diagnostics";
import { defaultAudioColors, validateAudioColors } from "./src/dev/audio_driven_colors";
import { defineConfig, type Plugin, type WebSocketClient } from "vite";
import { defaultBlobDiagnostics, validateBlobDiagnostics } from "./src/dev/blob_diagnostics_model";
import { defaultSmartPalette, validateSmartPalette } from "./src/dev/smart_palette";

import { defaultAccentComparison, validateAccentComparison } from "./src/dev/accent_color_comparison";

// Vite's dev websocket works across browser/WebView2 storage profiles.
// This bridge never exists in the production server or frontend bundle.
function visualTuningBridge(): Plugin {
  return {
    name: "ympleer-dev-visual-tuning",
    apply: "serve",
    configureServer(server) {
      let hybridOwner: WebSocketClient | undefined;
      function clearPaletteOwners() {
        audioTestOwner?.socket.off("close", releaseAudioComparison); audioTestOwner = undefined;
        audioOwner?.socket.off("close", releaseAudioColors); audioOwner = undefined;
        comparisonOwner?.socket.off("close", releaseComparison); comparisonOwner = undefined;
        smartOwner?.socket.off("close", releaseSmartPalette); smartOwner = undefined;
      }
      function clearHybridOwner() {
        hybridOwner?.socket.off("close", releaseHybrid);
        hybridOwner = undefined;
      }
      function claimHybrid(client: WebSocketClient) {
        clearHybridOwner(); clearPaletteOwners();
        hybridOwner = client;
        client.socket.once("close", releaseHybrid);
      }
      function releaseHybrid() {
        if (!hybridOwner) return;
        clearHybridOwner(); clearPaletteOwners();
        server.ws.send("visual-tuning:command", { action: "hybrid-palette", values: false });
      }
      let audioTestOwner: WebSocketClient | undefined;
      function releaseAudioComparison() {
        if (!audioTestOwner) return;
        audioTestOwner.socket.off("close", releaseAudioComparison);
        audioTestOwner = undefined;
        server.ws.send("visual-tuning:command", { action: "audio-colors-comparison", values: defaultAudioComparison() });
      }
      let audioOwner: WebSocketClient | undefined;
      function releaseAudioColors() {
        if (!audioOwner) return;
        audioOwner.socket.off("close", releaseAudioColors);
        audioOwner = undefined;
        server.ws.send("visual-tuning:command", { action: "audio-driven-colors", values: defaultAudioColors() });
      }
      let comparisonOwner: WebSocketClient | undefined;
      function releaseComparison() {
        if (!comparisonOwner) return;
        comparisonOwner.socket.off("close", releaseComparison);
        comparisonOwner = undefined;
        server.ws.send("visual-tuning:command", { action: "accent-recovery-comparison", values: defaultAccentComparison() });
      }
      let smartOwner: WebSocketClient | undefined;
      function releaseSmartPalette() {
        if (!smartOwner) return;
        smartOwner.socket.off("close", releaseSmartPalette);
        smartOwner = undefined;
        server.ws.send("visual-tuning:command", { action: "smart-palette", values: defaultSmartPalette() });
      }
      let diagnosticOwner: WebSocketClient | undefined;
      function releaseDiagnostics() {
        diagnosticOwner?.socket.off("close", releaseDiagnostics);
        diagnosticOwner = undefined;
        server.ws.send("visual-tuning:command", { action: "hide-pixi-canvas", values: false });
        server.ws.send("visual-tuning:command", { action: "css-highlights-isolation", values: false });
        server.ws.send("visual-tuning:command", { action: "blob-diagnostics", values: defaultBlobDiagnostics() });
      }
      server.middlewares.use("/__ympleer_dev_tuning", (_request, response) => {
        response.setHeader("Content-Type", "application/json");
        response.end(JSON.stringify({ project: "ympleer-v2", version: 2 }));
      });
      server.ws.on("visual-tuning:command", (data, client) => {
        if (data?.action === "blob-diagnostics-release") {
          if (hybridOwner === client) releaseHybrid();
          if (audioTestOwner === client) releaseAudioComparison();
          if (audioOwner === client) releaseAudioColors();
          if (comparisonOwner === client) releaseComparison();
          if (smartOwner === client) releaseSmartPalette();
          if (diagnosticOwner === client) releaseDiagnostics();
          return;
        }
        if (data?.action === "hybrid-palette") {
          try { validateHybridPalette(data.values); } catch { return; }
          if (data.values) claimHybrid(client);
          else { clearHybridOwner(); clearPaletteOwners(); }
        }
        if (data?.action === "audio-colors-comparison") {
          try { validateAudioComparison(data.values); } catch { return; }
          if (hybridOwner && hybridOwner !== client) claimHybrid(client);
          if (audioTestOwner !== client) {
            audioTestOwner?.socket.off("close", releaseAudioComparison);
            audioTestOwner = client;
            client.socket.once("close", releaseAudioComparison);
          }
        }
        if (data?.action === "audio-driven-colors") {
          try { validateAudioColors(data.values); } catch { return; }
          if (hybridOwner && hybridOwner !== client) claimHybrid(client);
          if (audioOwner !== client) {
            audioOwner?.socket.off("close", releaseAudioColors);
            audioOwner = client;
            client.socket.once("close", releaseAudioColors);
          }
        }
        if (data?.action === "accent-recovery-comparison") {
          try { validateAccentComparison(data.values); } catch { return; }
          if (hybridOwner && hybridOwner !== client) claimHybrid(client);
          if (comparisonOwner !== client) {
            comparisonOwner?.socket.off("close", releaseComparison);
            comparisonOwner = client;
            client.socket.once("close", releaseComparison);
          }
        }
        if (data?.action === "smart-palette") {
          try { validateSmartPalette(data.values); } catch { return; }
          if (hybridOwner && hybridOwner !== client) claimHybrid(client);
          if (smartOwner !== client) {
            smartOwner?.socket.off("close", releaseSmartPalette);
            smartOwner = client;
            client.socket.once("close", releaseSmartPalette);
          }
        }
        const displayDiagnostic = data?.action === "css-highlights-isolation" || data?.action === "hide-pixi-canvas";
        if (data?.action === "ambient-haze") return; // Appearance owns this setting now.
        if (displayDiagnostic || (data?.action === "blob-diagnostics" && data.values?.measure !== true)) {
          if (displayDiagnostic) {
            if (typeof data.values !== "boolean") return;
          } else {
            try { validateBlobDiagnostics(data.values); } catch { return; }
          }
          if (diagnosticOwner !== client) {
            diagnosticOwner?.socket.off("close", releaseDiagnostics);
            diagnosticOwner = client;
            // Socket close is the fallback when pagehide cannot deliver its message.
            client.socket.once("close", releaseDiagnostics);
          }
        }
        server.ws.send("visual-tuning:command", data);
      });
      server.ws.on("visual-tuning:state", data => server.ws.send("visual-tuning:state", data));
    },
  };
}

export default defineConfig({
  plugins: [visualTuningBridge()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
  },
});


