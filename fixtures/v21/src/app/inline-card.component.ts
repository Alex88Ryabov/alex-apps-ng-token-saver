import { Component, input } from '@angular/core';
import { UserVm } from './user-card.component';

@Component({
  selector: 'app-inline-card',
  template: `
    <h2>{{ greeting }}</h2>
    <p>{{ user().fullName }}</p>
    <button (click)="onSelect(user().id)">select</button>

    <p>{{ user().emailAddress }}</p>
    <button (click)="onSelect('not-a-number')">broken</button>
  `,
})
export class InlineCardComponent {
  user = input.required<UserVm>();

  greeting = 'Hello';

  onSelect(id: number): void {
    this.greeting = String(id);
  }
}
