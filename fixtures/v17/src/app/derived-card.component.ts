import { Component, Input } from '@angular/core';
import { BasePanel } from './base-panel';

@Component({
  selector: 'app-derived-card',
  standalone: true,
  template: '<h3 (click)="focus()">{{ heading }}</h3>',
})
export class DerivedCardComponent extends BasePanel {
  @Input() accent = false;

  override focus(): void {}
}
