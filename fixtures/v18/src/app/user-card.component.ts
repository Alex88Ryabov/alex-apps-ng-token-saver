import { Component, input, output } from '@angular/core';

export interface UserVm {
  id: number;
  fullName: string;
}

// Before v19 standalone is not the default, so it is stated explicitly (boundary measured, section 2.14).
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
