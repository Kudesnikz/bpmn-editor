declare module 'bpmn-moddle' {
  export interface FromXmlResult {
    rootElement: any;
    warnings?: Array<{ message?: string }>;
  }

  export default class BpmnModdle {
    constructor(packages?: Record<string, unknown>);
    fromXML(xml: string): Promise<FromXmlResult>;
    toXML(root: any, options?: Record<string, unknown>): Promise<{ xml: string }>;
    create(type: string, properties?: Record<string, unknown>): any;
    createAny(name: string, uri: string, properties?: Record<string, unknown>): any;
    getType(type: string): any;
    getTypeDescriptor(type: string): any;
    getPackages(): any[];
  }
}

declare module 'bpmn-auto-layout' {
  export function layoutProcess(xml: string): Promise<{ xml: string; warnings: Array<{ code?: string; message?: string }> }>;
}
