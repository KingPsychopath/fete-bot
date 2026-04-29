import { describe, expect, it } from "vitest";

import { parseHumanPhoneInput } from "./phone.js";

describe("parseHumanPhoneInput", () => {
  it("accepts phone numbers copied with Unicode plus signs and hidden marks", () => {
    const examples = [
      "\u200e+2348105867673",
      "\uFF0B2348105867673",
      "+234\u200e8105867673",
    ];

    for (const example of examples) {
      expect(parseHumanPhoneInput(example)).toMatchObject({
        ok: true,
        e164: "+2348105867673",
        jid: "2348105867673@s.whatsapp.net",
      });
    }
  });
});
