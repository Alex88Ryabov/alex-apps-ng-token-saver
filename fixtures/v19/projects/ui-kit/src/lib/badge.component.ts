import { Component, Input } from '@angular/core';

@Component({
  selector: 'ui-badge',
  standalone: true,
  templateUrl: './badge.component.html',
})
export class BadgeComponent {
  @Input() label = '';

  get upper(): string {
    return this.label.toUpperCase();
  }

  clear(): void {
    this.label = '';
  }
}
