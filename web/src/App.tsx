import { useState } from "react";
import { LiveView } from "./LiveView";
import { TagsView } from "./TagsView";

type Tab = "live" | "tags";

export function App() {
  const [tab, setTab] = useState<Tab>("live");

  return (
    <>
      <header>
        <div>
          <h1>STRATA</h1>
          <div className="sub">Industrial data streaming</div>
        </div>
        <nav>
          <button
            className={tab === "live" ? "active" : ""}
            onClick={() => setTab("live")}
          >
            Temps réel
          </button>
          <button
            className={tab === "tags" ? "active" : ""}
            onClick={() => setTab("tags")}
          >
            Tags
          </button>
        </nav>
      </header>
      <main>{tab === "live" ? <LiveView /> : <TagsView />}</main>
    </>
  );
}
