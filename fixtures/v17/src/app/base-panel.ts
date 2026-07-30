import { Directive, Input } from '@angular/core';
import { BaseWidget } from './base-widget';

@Directive()
export abstract class BasePanel extends BaseWidget {
  @Input() heading = '';

  collapse(animated: boolean): void {}
}
