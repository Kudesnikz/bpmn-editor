declare module 'bpmn-moddle' {
  export interface FromXmlResult {
    rootElement: any;
    warnings?: Array<{ message?: string }>;
  }

  export default class BpmnModdle {
    fromXML(xml: string): Promise<FromXmlResult>;
  }
}
