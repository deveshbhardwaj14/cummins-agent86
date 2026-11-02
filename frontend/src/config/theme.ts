import { createLightTheme, type BrandVariants, type Theme } from "@fluentui/react-components";

const johnDeereBrand: BrandVariants = {
  10: "#071A03",
  20: "#102C08",
  30: "#193F0D",
  40: "#204C16",
  50: "#24571C",
  60: "#286221",
  70: "#306F26",
  80: "#367C2B",
  90: "#4D913D",
  100: "#68A356",
  110: "#83B570",
  120: "#9EC68C",
  130: "#B8D7AA",
  140: "#D0E6C6",
  150: "#E5F1DF",
  160: "#F4F9F1",
};

export const johnDeereTheme: Theme = {
  ...createLightTheme(johnDeereBrand),
};
