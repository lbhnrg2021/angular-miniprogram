import { NgDefaultDirective, NgTemplateMeta } from './interface';

export class TemplateGlobalContext {
  bindIndex = 0;
  private templateList: NgTemplateMeta<NgDefaultDirective>[] = [];
  addTemplate(template: NgTemplateMeta<NgDefaultDirective>) {
    this.templateList.push(template);
  }
  findTemplate(name: string) {
    return this.templateList.find((item) =>
      item.directive
        .filter((item) => item.type === 'none')
        .find((directive) => directive.name.some((item) => item.name === name))
    );
  }
  getBindIndex() {
    return this.bindIndex++;
  }
}
