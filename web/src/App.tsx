import type { ReactElement } from "react";

import { useHashRoute } from "./router.js";
import { HomeScreen } from "./screens/HomeScreen.js";
import { NewRunWizard } from "./screens/NewRunWizard.js";
import { ProgressScreen } from "./screens/ProgressScreen.js";
import { ResultsScreen } from "./screens/ResultsScreen.js";

export function App(): ReactElement {
  const route = useHashRoute();
  switch (route.name) {
    case "new":
      return <NewRunWizard />;
    case "run":
      return <ProgressScreen key={route.runId} runId={route.runId} />;
    case "results":
      return <ResultsScreen key={route.runId} runId={route.runId} />;
    default:
      return <HomeScreen />;
  }
}
