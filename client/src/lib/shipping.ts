import type { ShipmentProvider, ShippingView } from "./types";

/** Every label service by name, as the admin pages say it. */
export const PROVIDER_NAMES: Record<ShipmentProvider, string> = {
  SHIPROCKET: "Shiprocket",
  DELHIVERY: "Delhivery",
  EASYPOST: "EasyPost",
  SHIPPO: "Shippo",
  SHIPSTATION: "ShipStation",
  SENDCLOUD: "Sendcloud",
  DHL_EXPRESS: "DHL Express",
  FEDEX: "FedEx",
  AUSPOST: "Australia Post",
  DEUTSCHE_POST: "DHL Paket",
  EXTERNAL: "External connector",
};

/** The services in the order the Shipping page lists them. */
export const PROVIDERS: ShipmentProvider[] = [
  "SHIPROCKET",
  "DELHIVERY",
  "EASYPOST",
  "SHIPPO",
  "SHIPSTATION",
  "SENDCLOUD",
  "DHL_EXPRESS",
  "FEDEX",
  "AUSPOST",
  "DEUTSCHE_POST",
  "EXTERNAL",
];

/** Whether a service is connected, and whether it's in a test mode, from the view. */
export const accountOf = (data: ShippingView, id: ShipmentProvider): { testMode: boolean } | null => {
  switch (id) {
    case "SHIPROCKET":
      return data.shiprocket;
    case "DELHIVERY":
      return data.delhivery && { testMode: data.delhivery.staging };
    case "EASYPOST":
      return data.easypost;
    case "SHIPPO":
      return data.shippo;
    case "SHIPSTATION":
      return data.shipstation;
    case "SENDCLOUD":
      return data.sendcloud;
    case "DHL_EXPRESS":
      return data.dhlExpress;
    case "FEDEX":
      return data.fedex;
    case "AUSPOST":
      return data.ausPost;
    case "DEUTSCHE_POST":
      return data.deutschePost;
    case "EXTERNAL":
      return data.external;
  }
};

export const connectedProviders = (data: ShippingView): ShipmentProvider[] => PROVIDERS.filter((id) => Boolean(accountOf(data, id)));
