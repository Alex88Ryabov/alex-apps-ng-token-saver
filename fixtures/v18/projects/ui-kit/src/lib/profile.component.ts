import { Component, input } from '@angular/core';
import { UserVm } from '@fixture/models';

@Component({
  selector: 'ui-profile',
  standalone: true,
  templateUrl: './profile.component.html',
})
export class ProfileComponent {
  user = input.required<UserVm>();

  select(id: number): void {
    this.user().id === id;
  }
}
