import { Component, input, output } from '@angular/core';

export interface UserVm {
  id: number;
  fullName: string;
}

// On v19 standalone is already the default (section 2.14), but the flag is here on purpose: real
// code is written that way, and it checks that the decorator wins over the version default.
@Component({
  selector: 'app-user-card',
  standalone: true,
  templateUrl: './user-card.component.html',
})
export class UserCardComponent {
  user = input.required<UserVm>();

  selected = output<number>();

  greeting = 'Hello';

  onSelect(id: number): void {
    this.selected.emit(id);
  }
}
