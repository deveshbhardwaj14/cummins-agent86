import { createLightTheme, type BrandVariants, type Theme } from "@fluentui/react-components";

const agentJBrand: BrandVariants = {
  10: "#210203",
  20: "#390608",
  30: "#570A0E",
  40: "#700D13",
  50: "#8B1018",
  60: "#A5121D",
  70: "#BA1420",
  80: "#CE1628",
  90: "#DC3847",
  100: "#E65D69",
  110: "#ED7E88",
  120: "#F39DA5",
  130: "#F8B8BE",
  140: "#FBD0D4",
  150: "#FDE5E7",
  160: "#FFF3F4",
};

export const agentJTheme: Theme = {
  ...createLightTheme(agentJBrand),
};
