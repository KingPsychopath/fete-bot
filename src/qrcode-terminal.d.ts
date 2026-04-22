declare module "qrcode-terminal" {
  export type GenerateOptions = {
    small?: boolean;
  };

  export type GenerateCallback = (qrcode: string) => void;

  export interface QRCodeTerminal {
    generate(input: string, options?: GenerateOptions, callback?: GenerateCallback): void;
  }

  const qrcodeTerminal: QRCodeTerminal;
  export default qrcodeTerminal;
}
