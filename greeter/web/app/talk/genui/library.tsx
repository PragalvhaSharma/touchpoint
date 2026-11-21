"use client";

// The component library the model writes screens with: the definitions in schema.ts (shared with the
// server's prompt) joined to their renderers. One source for names, props and descriptions.
import { createLibrary, type ComponentRenderer } from "@openuidev/react-lang";
import { ConstellationView } from "./components/constellation";
import { FacesView } from "./components/faces";
import { PathView } from "./components/path";
import { PortraitView } from "./components/portrait";
import { BadgesView, GridView, ImageView, StackView, TextView } from "./components/primitives";
import { ProjectMomentView } from "./components/project";
import { SpotlightView } from "./components/spotlight";
import { BigNumberView, QuoteMomentView } from "./components/words";
import { ROOT, componentGroups, components } from "./schema";

const views: Record<string, ComponentRenderer<never>> = {
  Stack: StackView,
  Grid: GridView,
  Portrait: PortraitView,
  ProjectMoment: ProjectMomentView,
  Spotlight: SpotlightView,
  Faces: FacesView,
  Path: PathView,
  QuoteMoment: QuoteMomentView,
  BigNumber: BigNumberView,
  Constellation: ConstellationView,
  Image: ImageView,
  Text: TextView,
  Badges: BadgesView,
};

export const library = createLibrary({
  root: ROOT,
  componentGroups,
  components: components.map((c) => {
    const component = views[c.name];
    if (!component) throw new Error(`genui: no renderer for ${c.name}`);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- each renderer is typed against its own props
    return { ...c, component: component as ComponentRenderer<any> };
  }),
});
