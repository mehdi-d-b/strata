import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { AuthProvider } from "./auth";
import { ThemeProvider } from "./theme";
import { DensityProvider } from "./density";
import "uplot/dist/uPlot.min.css";
import "./tailwind.css";
import "./style.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ThemeProvider>
      <DensityProvider>
        <AuthProvider>
          <App />
        </AuthProvider>
      </DensityProvider>
    </ThemeProvider>
  </React.StrictMode>,
);
